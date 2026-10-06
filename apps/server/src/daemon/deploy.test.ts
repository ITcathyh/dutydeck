import { createRepositories, type SqliteDriverCheck, type SqliteDriverCheckOptions } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig } from '@dutydeck/shared';
import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutostartCommandOutput } from '../autostart/autostart.js';
import { DRAIN_INTERVAL_MS } from './command.js';
import { parseDeployWindows, runDeploy, shanghaiMinuteOfDay, withinDeployWindow, type DeployDeps } from './deploy.js';

const passingSqlite = (options?: SqliteDriverCheckOptions): SqliteDriverCheck => ({ ok: true, execPath: options?.execPath ?? process.execPath });

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function link(target: string, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const betterSqliteUrl = pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href;

interface CliBehaviour {
  health?: number;
  activity?: number;
  versionExit?: number;
  /** 这个版本认识的最高迁移版本：启动时像真服务一样，库比它新就以 DATABASE_SCHEMA_TOO_NEW 退出，否则补上缺的迁移。 */
  knownSchema?: number;
  executeQueued?: boolean;
}

/** 假的 dist/cli.js：--version 前先加载 dep-a（它再加载 dep-b），否则起一个回答排空、任务数、健康检查的 HTTP 服务。 */
function cliSource(behaviour: CliBehaviour) {
  return `import a from 'dep-a';
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('0.0.3'); process.exit(${behaviour.versionExit ?? 0}); }
${behaviour.knownSchema === undefined ? '' : `const { default: Database } = await import(${JSON.stringify(betterSqliteUrl)});
const db = new Database(process.argv[process.argv.indexOf('--database') + 1]);
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
const applied = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
if (applied > ${behaviour.knownSchema}) { console.error('DATABASE_SCHEMA_TOO_NEW'); process.exit(1); }
for (let version = applied + 1; version <= ${behaviour.knownSchema}; version++) db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(version, 'test');
${behaviour.executeQueued ? `for (const task of db.prepare("SELECT id FROM tasks WHERE status = 'queued'").all()) {
  appendFileSync(process.argv[process.argv.indexOf('--database') + 1] + '.effects', task.id + '\\n');
  db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(task.id);
}` : ''}
`}const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const status = path === '/health' ? ${behaviour.health ?? 200} : path === '/api/system/activity' ? ${behaviour.activity ?? 200} : 200;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(path === '/health' ? { ok: status === 200, dep: a } : path === '/api/system/activity' ? { runningTasks: 0 } : { draining: true }));
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;
}

/** 按 pnpm 隔离布局造一个已构建的检出目录：dep-a 依赖 dep-b，dev-only 只是 devDependency。 */
function fakeCheckout(root: string, behaviour: CliBehaviour = {}) {
  const server = join(root, 'apps', 'server');
  const store = join(root, 'node_modules', '.pnpm');
  write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  write(join(server, 'package.json'), JSON.stringify({ name: '@byted/dutydeck', version: '0.0.3', type: 'module', dependencies: { 'dep-a': '1.0.0' }, devDependencies: { 'dev-only': '1.0.0' } }));
  for (const [id, name, code] of [['dep-a@1.0.0', 'dep-a', "import b from 'dep-b'; export default `a+${b}`;"], ['dep-b@1.0.0', 'dep-b', "export default 'b';"], ['dev-only@1.0.0', 'dev-only', "export default 'dev';"]] as const) {
    write(join(store, id, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }));
    write(join(store, id, 'node_modules', name, 'index.js'), code);
  }
  link('../../dep-b@1.0.0/node_modules/dep-b', join(store, 'dep-a@1.0.0', 'node_modules', 'dep-b'));
  link('../dep-b@1.0.0/node_modules/dep-b', join(store, 'node_modules', 'dep-b'));
  link('../dev-only@1.0.0/node_modules/dev-only', join(store, 'node_modules', 'dev-only'));
  link('../../../node_modules/.pnpm/dep-a@1.0.0/node_modules/dep-a', join(server, 'node_modules', 'dep-a'));
  link('../../../node_modules/.pnpm/dev-only@1.0.0/node_modules/dev-only', join(server, 'node_modules', 'dev-only'));
  write(join(server, 'dist', 'agents', 'claude-acp.mjs'), '');
  write(join(server, 'dist', 'agents', 'env-launcher.mjs'), '');
  write(join(server, 'public', 'index.html'), '<html></html>');
  write(join(server, 'src.txt'), 'v1');
  git(root, 'init', '-q');
  git(root, 'add', 'pnpm-workspace.yaml', 'apps/server/package.json', 'apps/server/src.txt');
  git(root, 'commit', '-q', '-m', 'initial');
  write(join(server, 'dist', 'cli.js'), cliSource(behaviour));
  return root;
}

/** 在同一检出里提交一次新改动并「重新构建」，得到一个新版本。 */
function nextCommit(root: string, behaviour: CliBehaviour = {}) {
  write(join(root, 'apps', 'server', 'src.txt'), String(Math.random()));
  git(root, 'commit', '-q', '-am', 'next');
  write(join(root, 'apps', 'server', 'dist', 'cli.js'), cliSource(behaviour));
}

async function freePort(): Promise<number> {
  return await new Promise(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

/** 可替换的进程管理：restart 停掉旧进程，再按 current 起一个新的。 */
function processService(releases: string, port: number, database: string) {
  let child: ChildProcess | undefined;
  const ran: string[] = [];
  return {
    ran,
    mainPid: async () => child && child.exitCode === null && child.signalCode === null ? child.pid : undefined,
    restart: async () => {
      if (child) await stop(child);
      ran.push(realpathSync(join(releases, 'current')));
      child = spawn(process.execPath, [join(releases, 'current', 'dist', 'cli.js'), '--port', String(port), '--database', database], { stdio: 'ignore' });
      return undefined;
    },
    stop: async () => {
      if (child) await stop(child);
      return undefined;
    }
  };
}

describe('部署窗口', () => {
  it('解析多段窗口，拒绝格式错误', () => {
    expect(parseDeployWindows('10:00-11:00, 16:00-17:30')).toEqual([{ start: 600, end: 660 }, { start: 960, end: 1050 }]);
    expect(parseDeployWindows('23:30-00:30')).toEqual([{ start: 1410, end: 30 }]);
    for (const bad of ['', '10-11', '10:00-10:00', '24:00-01:00', '10:00-11:60', '10:00-11:00,oops']) expect(parseDeployWindows(bad)).toBeUndefined();
  });

  it('按 Asia/Shanghai（UTC+8）判断，结束时刻不含在内，支持跨零点', () => {
    const windows = parseDeployWindows('10:00-11:00,16:00-17:00')!;
    expect(shanghaiMinuteOfDay(new Date('2026-09-25T02:00:00Z'))).toBe(600);
    expect(withinDeployWindow(windows, new Date('2026-09-25T02:00:00Z'))).toBe(true);
    expect(withinDeployWindow(windows, new Date('2026-09-25T02:59:59Z'))).toBe(true);
    expect(withinDeployWindow(windows, new Date('2026-09-25T03:00:00Z'))).toBe(false);
    expect(withinDeployWindow(windows, new Date('2026-09-25T08:30:00Z'))).toBe(true);
    const overnight = parseDeployWindows('23:30-00:30')!;
    expect(withinDeployWindow(overnight, new Date('2026-09-25T16:10:00Z'))).toBe(true);
    expect(withinDeployWindow(overnight, new Date('2026-09-25T15:00:00Z'))).toBe(false);
  });
});

describe('dutydeck deploy', () => {
  let tmp: string;
  let source: string;
  let releases: string;
  let bot: string;
  let database: string;
  let port: number;
  let service: ReturnType<typeof processService>;
  const info = vi.fn();
  const warn = vi.fn();

  beforeEach(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dutydeck-deploy-')));
    source = fakeCheckout(join(tmp, 'checkout'));
    bot = join(tmp, 'bot');
    releases = join(bot, '.dutydeck', 'releases');
    database = join(bot, 'dutydeck.db');
    mkdirSync(bot, { recursive: true });
    const db = new Database(database);
    db.exec("CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT); INSERT INTO configs VALUES ('marker', 'before-deploy');");
    db.close();
    port = await freePort();
    writeFileSync(join(bot, 'deployment.json'), JSON.stringify({ address: `http://127.0.0.1:${port}`, databasePath: database, keep: 'me' }));
    service = processService(releases, port, database);
    info.mockClear();
    warn.mockClear();
  });

  afterEach(async () => {
    await service.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const deps = (extra: Partial<DeployDeps> = {}): DeployDeps => ({ service, checkSqlite: passingSqlite, readToken: () => undefined, info, warn, healthTimeoutMs: 10_000, env: {}, ...extra });

  it('复制出只含生产依赖、脱离源检出也能加载的发布目录，排空、备份后切换 current，重启并通过健康检查', async () => {
    const first = await runDeploy({ source, runtime: bot }, deps());
    expect(first, first.error).toMatchObject({ ok: true, status: 'deployed' });
    expect(first.previousRelease).toBeUndefined();
    expect(realpathSync(join(releases, 'current'))).toBe(first.release);
    expect(readlinkSync(join(releases, 'current'))).not.toMatch(/^\//);
    expect(existsSync(join(first.release!, 'node_modules', 'dep-a'))).toBe(true);
    expect(existsSync(join(first.release!, 'node_modules', '.pnpm', 'dep-b@1.0.0'))).toBe(true);
    expect(existsSync(join(first.release!, 'node_modules', '.pnpm', 'dev-only@1.0.0'))).toBe(false);
    expect(existsSync(join(first.release!, 'node_modules', '.pnpm', 'node_modules', 'dev-only'))).toBe(false);

    nextCommit(source);
    const second = await runDeploy({ source, runtime: bot }, deps());
    expect(second, second.error).toMatchObject({ ok: true, status: 'deployed', previousRelease: first.release });
    expect(realpathSync(join(releases, 'current'))).toBe(second.release);
    expect(service.ran).toEqual([first.release, second.release]);
    expect(second.pid).toBe(await service.mainPid());
    expect(info).toHaveBeenCalledWith(expect.stringContaining('排空'));
    expect(second.pruned).toEqual({ removed: [], inUse: [], freedBytes: 0 });
    expect(second.prunedRecords).toEqual({ removed: [], freedBytes: 0 });

    const manifest = JSON.parse(readFileSync(second.manifest!, 'utf8'));
    expect(manifest).toMatchObject({
      created_by: 'dutydeck deploy', status: 'deployed', commit: git(source, 'rev-parse', 'HEAD'), release: second.release, previous_release: first.release,
      new_cli_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), previous_cli_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), previous_pid: expect.any(Number), new_pid: second.pid
    });
    expect(dirname(second.manifest!)).toBe(join(bot, '.dutydeck', 'deployments', manifest.release.split('/').at(-1)));
    const backup = new Database(manifest.database_backup, { readonly: true });
    expect(backup.prepare('SELECT value FROM configs WHERE key = ?').get('marker')).toEqual({ value: 'before-deploy' });
    backup.close();
    const deployment = JSON.parse(readFileSync(join(bot, 'deployment.json'), 'utf8'));
    expect(deployment).toMatchObject({ keep: 'me', commit: manifest.commit, release: second.release, runtimePath: join(releases, 'current'), deploymentRecord: second.manifest });

    // 源检出挪走后，发布目录仍能独立加载依赖。
    renameSync(source, `${source}-moved`);
    const version = spawnSync(process.execPath, [join(releases, 'current', 'dist', 'cli.js'), '--version'], { encoding: 'utf8' });
    expect(version.stdout.trim()).toBe('0.0.3');
  }, 60_000);

  it('新版本健康检查不过时切回上一版并重启', async () => {
    const first = await runDeploy({ source, runtime: bot }, deps());
    expect(first.ok).toBe(true);
    nextCommit(source, { health: 503 });

    const broken = await runDeploy({ source, runtime: bot }, deps({ healthTimeoutMs: 2_500 }));

    expect(broken).toMatchObject({ ok: false, status: 'rolled_back', previousRelease: first.release });
    expect(broken.error).toContain('HTTP 503');
    expect(realpathSync(join(releases, 'current'))).toBe(first.release);
    expect(service.ran).toEqual([first.release, broken.release, first.release]);
    // 库的迁移版本没变：只切回可执行文件，不动数据库
    expect(JSON.parse(readFileSync(broken.manifest!, 'utf8'))).toMatchObject({ status: 'rolled_back', new_pid: await service.mainPid(), database_restored: false });
    // deployment.json 仍记着上一版
    expect(JSON.parse(readFileSync(join(bot, 'deployment.json'), 'utf8')).release).toBe(first.release);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('切回'));
    // 回滚后不清理旧发布目录和部署记录
    expect(broken.pruned).toBeUndefined();
    expect(broken.prunedRecords).toBeUndefined();
  }, 60_000);

  /** 记下每个请求发生在哪个阶段；排空请求带上 draining 的值。 */
  function recordRequests() {
    const calls: string[] = [];
    const recorder = { phase: 'drain', calls, fetch: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = path === '/api/system/drain' ? ` ${JSON.parse(String(init?.body)).draining}` : '';
      calls.push(`${recorder.phase} ${path}${body}`);
      return await fetch(url, init);
    }) as typeof fetch };
    return recorder;
  }

  it('从排空起一直续租到旧进程退出：备份、切换、重启期间都续租，旧进程退出后不再续到新进程上', async () => {
    await runDeploy({ source, runtime: bot }, deps());
    nextCommit(source);
    const requests = recordRequests();
    const tick = async (intervals: number) => {
      vi.advanceTimersByTime(intervals * DRAIN_INTERVAL_MS);
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    const slowRestart = {
      ...service,
      restart: async () => {
        requests.phase = 'restart';
        await tick(1); // 停旧进程之前
        const error = await service.restart();
        requests.phase = 'after-restart';
        await tick(3); // 旧进程已退出，新进程在跑
        return error;
      }
    };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const result = await runDeploy({ source, runtime: bot }, deps({
        service: slowRestart,
        fetch: requests.fetch,
        backupDatabase: async () => { requests.phase = 'backup'; await tick(3); } // 相当于备份跑了 15 秒
      }));
      expect(result, result.error).toMatchObject({ ok: true, status: 'deployed' });
    } finally {
      vi.useRealTimers();
    }
    expect(requests.calls.filter(call => call === 'backup /api/system/drain true')).toHaveLength(3);
    expect(requests.calls.filter(call => call === 'restart /api/system/drain true')).toHaveLength(1);
    expect(requests.calls.filter(call => call.startsWith('after-restart /api/system/drain'))).toEqual([]);
  }, 60_000);

  it('备份失败时先停止续租再退出排空，之后不再续租', async () => {
    const first = await runDeploy({ source, runtime: bot }, deps());
    nextCommit(source);
    const requests = recordRequests();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const result = await runDeploy({ source, runtime: bot }, deps({
        fetch: requests.fetch,
        backupDatabase: async () => {
          vi.advanceTimersByTime(2 * DRAIN_INTERVAL_MS);
          await new Promise(resolve => setTimeout(resolve, 100));
          throw new Error('disk full');
        }
      }));
      expect(result).toMatchObject({ ok: false, status: 'failed' });
      expect(realpathSync(join(releases, 'current'))).toBe(first.release);
      expect(service.ran).toEqual([first.release]);
      requests.phase = 'after';
      vi.advanceTimersByTime(3 * DRAIN_INTERVAL_MS);
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally {
      vi.useRealTimers();
    }
    expect(requests.calls.filter(call => call.includes('/api/system/drain'))).toEqual([
      'drain /api/system/drain true', 'drain /api/system/drain true', 'drain /api/system/drain true', 'drain /api/system/drain false'
    ]);
  }, 60_000);

  it('新版本执行排队任务并迁移后健康失败：保留执行事实、停止服务且不切回旧版', async () => {
    const initial = new Database(database);
    initial.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT);");
    initial.close();
    nextCommit(source, { knownSchema: 24, executeQueued: true });
    const first = await runDeploy({ source, runtime: bot }, deps());
    expect(first, first.error).toMatchObject({ ok: true, status: 'deployed' });
    const queued = new Database(database);
    queued.exec("INSERT INTO tasks VALUES ('queued-before-deploy', 'queued');");
    queued.close();
    nextCommit(source, { knownSchema: 27, health: 503, executeQueued: true });
    const schema = (file: string) => {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try { return (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version; } finally { db.close(); }
    };
    // 新版已经执行过排队任务：旧快照不能覆盖这条执行事实。
    const order: string[] = [];
    const tracked = {
      ...service,
      restart: async () => { order.push(`restart ${schema(database)}`); return await service.restart(); },
      stop: async () => { order.push(`stop ${schema(database)}`); return await service.stop(); }
    };

    const broken = await runDeploy({ source, runtime: bot }, deps({ service: tracked, healthTimeoutMs: 2_500 }));

    expect(readFileSync(`${database}.effects`, 'utf8').trim().split('\n')).toEqual(['queued-before-deploy']);
    expect(broken, broken.error).toMatchObject({ ok: false, status: 'rollback_failed', previousRelease: first.release });
    expect(broken.error).toContain('人工恢复');
    expect(service.ran).toEqual([first.release, broken.release]);
    expect(order).toEqual(['restart 24', 'stop 27']);
    expect(await service.mainPid()).toBeUndefined();
    expect(realpathSync(join(releases, 'current'))).toBe(broken.release);
    expect(schema(database)).toBe(27);
    const latest = new Database(database, { readonly: true });
    expect(latest.prepare('SELECT status FROM tasks WHERE id = ?').get('queued-before-deploy')).toEqual({ status: 'completed' });
    latest.close();
    const manifest = JSON.parse(readFileSync(broken.manifest!, 'utf8'));
    expect(manifest).toMatchObject({
      status: 'rollback_failed', database_restored: false, schema_version_before: 24, schema_version_at_rollback: 27,
      database_before_rollback: join(dirname(broken.manifest!), 'dutydeck.db.before-rollback')
    });
    expect(schema(manifest.database_before_rollback)).toBe(27);
  }, 60_000);

  it('迁移失败保留备份之后收到的请求和配置，不发可能重复执行的重发提醒', async () => {
    nextCommit(source, { knownSchema: 24 });
    const first = await runDeploy({ source, runtime: bot }, deps());
    expect(first, first.error).toMatchObject({ ok: true, status: 'deployed' });
    nextCommit(source, { knownSchema: 27, health: 503 });
    const inbox = (messageId: string, chatId: string, state: string, createTime: string, threadId?: string) => [`lark.inbox.cli_deploy.${messageId}`, JSON.stringify({
      appId: 'cli_deploy', boot: 'boot', state, event: { messageId, chatId, chatType: 'group', messageType: 'text', content: '{"text":"请求"}', createTime, mentions: [], ...(threadId ? { threadId } : {}) }
    })] as const;
    const put = (file: string, rows: ReadonlyArray<readonly [string, string]>) => {
      const db = new Database(file);
      try { for (const row of rows) db.prepare('INSERT OR REPLACE INTO configs VALUES (?, ?)').run(...row); } finally { db.close(); }
    };
    const inboxKeys = (file: string) => {
      const db = new Database(file, { readonly: true });
      try { return (db.prepare("SELECT key FROM configs WHERE key LIKE 'lark.inbox.%' ORDER BY key").all() as Array<{ key: string }>).map(row => row.key); } finally { db.close(); }
    };
    put(database, [['lark.bots', JSON.stringify([{ appId: 'cli_deploy', appSecret: 'deploy-secret', listening: true }])], inbox('om_before', 'oc_a', 'accepted', '10')]);
    const replies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const feishu: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      if (target.hostname !== 'open.feishu.cn') return await fetch(url, init);
      if (target.pathname.startsWith('/open-apis/auth/')) return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      replies.push({ path: target.pathname, body: JSON.parse(String(init?.body)) });
      return Response.json({ code: 0, data: { message_id: `om_notice_${replies.length}` } });
    };
    let backups = 0;
    const broken = await runDeploy({ source, runtime: bot }, deps({
      healthTimeoutMs: 2_500,
      fetch: feishu,
      backupDatabase: async (from, to) => {
        const db = new Database(from, { readonly: true });
        try { await db.backup(to); } finally { db.close(); }
        // 部署前的备份做完之后，旧进程在重启前照常收下的消息
        if (++backups === 1) {
          put(database, [
            inbox('om_a1', 'oc_a', 'received', '100'), inbox('om_a2', 'oc_a', 'accepted', '200'),
            inbox('om_t1', 'oc_a', 'command', '150', 'omt_topic'), inbox('om_denied', 'oc_c', 'failed', '120'),
            ['new-setting', 'after-backup']
          ]);
        }
      }
    }));

    expect(broken, broken.error).toMatchObject({ ok: false, status: 'rollback_failed' });
    const manifest = JSON.parse(readFileSync(broken.manifest!, 'utf8'));
    expect(manifest.database_restored).toBe(false);
    const expectedKeys = ['om_a1', 'om_a2', 'om_before', 'om_denied', 'om_t1'].map(id => `lark.inbox.cli_deploy.${id}`);
    expect(inboxKeys(database)).toEqual(expectedKeys);
    expect(inboxKeys(manifest.database_before_rollback)).toEqual(expectedKeys);
    const latest = new Database(database, { readonly: true });
    expect(latest.prepare('SELECT value FROM configs WHERE key = ?').get('new-setting')).toEqual({ value: 'after-backup' });
    latest.close();
    expect(replies).toEqual([]);
    expect(broken.error).not.toContain('重发');
    expect(service.ran).toEqual([first.release, broken.release]);
    expect(realpathSync(join(releases, 'current'))).toBe(broken.release);
    expect(JSON.stringify(manifest)).not.toContain('deploy-secret');
  }, 60_000);

  it.each([
    'same-schema', 'ddl-during-stop', 'migration-set-changed', 'current-unreadable', 'current-missing',
    'backup-missing', 'backup-unreadable', 'backup-schema-changed', 'initial-schema-unknown', 'initial-database-missing',
    'preservation-failed', 'stop-failed', 'stop-still-running', 'stop-threw', 'stop-check-threw',
    'no-persistent-database', 'memory-database'
  ])('回滚边界：%s', async scenario => {
    const first = await runDeploy({ source, runtime: bot, restart: false }, deps());
    nextCommit(source);
    if (scenario === 'initial-database-missing') rmSync(database);
    // 部署元数据不能证明服务没有持久库；受控服务仍会写真实 database 文件。
    if (scenario === 'no-persistent-database' || scenario === 'memory-database') {
      writeFileSync(join(bot, 'deployment.json'), JSON.stringify({ address: `http://127.0.0.1:${port}`, ...(scenario === 'memory-database' ? { databasePath: ':memory:' } : {}) }));
    }
    let clock = Date.now(), pid: number | undefined, backup: string | undefined, stopping = false;
    const ran: string[] = [], copies: Array<[string, string]> = [];
    const put = (sql: string) => { const db = new Database(database); try { db.exec(sql); } finally { db.close(); } };
    if (scenario === 'migration-set-changed') put('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES (1), (2)');
    const stopFailure = scenario.startsWith('stop-');
    const controlled = {
      mainPid: async () => {
        if (stopping && scenario === 'stop-check-threw') throw new Error('cannot inspect service');
        return pid;
      },
      restart: async () => {
        ran.push(realpathSync(join(releases, 'current')));
        pid = 1_000_000 + ran.length;
        if (ran.length === 1) {
          put("CREATE TABLE IF NOT EXISTS configs (key TEXT PRIMARY KEY, value TEXT); INSERT OR REPLACE INTO configs VALUES ('accepted-after-backup', 'retained')");
          if (scenario === 'current-unreadable') writeFileSync(database, 'unreadable current database');
          if (scenario === 'current-missing') rmSync(database);
          if (scenario === 'backup-missing') rmSync(backup!);
          if (scenario === 'backup-unreadable') writeFileSync(backup!, 'unreadable backup');
          if (scenario === 'backup-schema-changed') {
            const changed = new Database(backup!); changed.exec('CREATE TABLE changed_backup(id)'); changed.close();
          }
          if (scenario === 'preservation-failed') put('CREATE TABLE new_schema(id)');
          if (scenario === 'migration-set-changed') put('DELETE FROM schema_migrations WHERE version = 1');
        }
        return undefined;
      },
      stop: vi.fn(async () => {
        stopping = true;
        // A migration can finish after the health check but before stop completes.
        if (scenario === 'ddl-during-stop') put('CREATE TABLE late_schema(id)');
        if (scenario === 'stop-failed') return 'stop denied';
        if (scenario === 'stop-threw') throw new Error('stop failed');
        if (scenario !== 'stop-still-running') pid = undefined;
        return undefined;
      }),
      resetFailed: vi.fn(async () => {})
    };
    const result = await runDeploy({ source, runtime: bot }, deps({
      service: controlled, now: () => clock, healthTimeoutMs: 1,
      sleep: async () => { clock += 1000; },
      fetch: async () => Response.json({ ok: ran.length > 1 }, { status: ran.length > 1 ? 200 : 503 }),
      backupDatabase: async (from, to) => {
        copies.push([from, to]);
        if (copies.length === 1) backup = to;
        if (copies.length > 1 && scenario === 'preservation-failed') throw new Error('disk full');
        const db = new Database(from, { readonly: true, fileMustExist: true });
        try { await db.backup(to); } finally { db.close(); }
        if (copies.length === 1 && scenario === 'initial-schema-unknown') writeFileSync(to, 'unreadable initial backup');
      }
    }));
    const compatible = scenario === 'same-schema';
    expect(result.status, result.error).toBe(compatible ? 'rolled_back' : 'rollback_failed');
    expect(ran).toEqual(compatible ? [result.release, first.release] : [result.release]);
    expect(realpathSync(join(releases, 'current'))).toBe(compatible ? first.release : result.release);
    expect(controlled.stop).toHaveBeenCalledOnce();
    expect(controlled.resetFailed).toHaveBeenCalledTimes(compatible ? 1 : 0);
    expect(copies.every(([, to]) => to !== database)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifest!, 'utf8'));
    expect(manifest.database_restored).toBe(false);
    if (!compatible) {
      expect(result.error).toContain('人工恢复');
      expect(result.error).not.toContain('已切回');
      expect(result.error).not.toContain('重发');
      expect(manifest.rollback_blocked_reason).toEqual(expect.any(String));
      expect(manifest.rollback_service_stopped).toBe(!stopFailure);
      if (!stopFailure) expect(await controlled.mainPid()).toBeUndefined();
    }
    if (stopFailure) {
      expect(copies).toHaveLength(1);
      expect(manifest.schema_version_at_rollback).toBeUndefined();
    }
    if (scenario === 'no-persistent-database' || scenario === 'memory-database') {
      expect(result.error).toContain('无法验证目标数据库');
      expect(copies).toEqual([]);
      expect(manifest.schema_version_at_rollback).toBeUndefined();
    }
    if (scenario === 'preservation-failed') expect(manifest.database_preservation_error).toBe('disk full');
    if (scenario === 'current-unreadable') expect(readFileSync(database, 'utf8')).toBe('unreadable current database');
    else if (scenario === 'current-missing') expect(existsSync(database)).toBe(false);
    else {
      const db = new Database(database, { readonly: true });
      expect(db.prepare('SELECT value FROM configs WHERE key = ?').get('accepted-after-backup')).toEqual({ value: 'retained' });
      db.close();
    }
  });

  it('真实 Runtime 执行后部署失败：保留 attempt、提交事实及新请求，重开当前数据库不重放旧任务', async () => {
    rmSync(database);
    const agent: AgentConfig = { id: 'deploy-fixture', name: 'Deploy fixture', command: process.execPath, args: [], protocol: 'acp', cwd: tmp, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
    const effects: string[] = [];
    let current: { runtime: DutydeckRuntime; repos: ReturnType<typeof createRepositories> } | undefined;
    const open = () => {
      const repos = createRepositories(database, { mode: 'runtime', newDatabaseAuthority: 'ledger_v1' });
      const runtime = new DutydeckRuntime(repos, {
        driverIdleTimeoutMs: 0,
        driverFactory: (_config, _protocol, emit, _exit, sessionId) => ({
          start: async () => {},
          send: async () => {
            effects.push(runtime.getActiveTaskContext(sessionId!)!.taskId);
            emit({ type: 'text', data: { text: 'done' } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          },
          stop: async () => {}, isStopped: async () => true, interrupt: async () => {}, resume: async () => {}
        })
      });
      return current = { runtime, repos };
    };
    const close = async () => { if (current) { await current.runtime.shutdown(); current.repos.close(); current = undefined; } };
    try {
      const original = open();
      await original.runtime.initialize([agent]);
      original.runtime.setQueueHeld(true);
      const session = await original.runtime.start({ agentId: agent.id });
      const queued = await original.runtime.dispatch(session.id, 'execute once');
      expect(queued.status).toBe('queued');
      await close();
      const first = await runDeploy({ source, runtime: bot, restart: false }, deps());
      nextCommit(source);
      let pid: number | undefined, clock = Date.now(), addedId: string | undefined;
      let completedAttempt: unknown;
      const ran: string[] = [];
      const controlled = {
        mainPid: async () => pid,
        restart: async () => {
          ran.push(realpathSync(join(releases, 'current')));
          pid = 1_000_000 + ran.length;
          const upgraded = open();
          await upgraded.runtime.initialize([agent]);
          await vi.waitFor(() => expect(upgraded.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('completed'));
          completedAttempt = upgraded.repos.execution.getTaskExecution(queued.id)!.currentAttempt;
          expect(completedAttempt).toMatchObject({ state: 'settled', outcome: 'completed' });
          expect(completedAttempt).not.toMatchObject({ submissionState: 'not_submitted' });
          upgraded.runtime.setQueueHeld(true);
          addedId = (await upgraded.runtime.dispatch(session.id, 'accepted after backup')).id;
          await upgraded.repos.config.set('after-backup', 'retained');
          const migration = new Database(database);
          migration.exec('CREATE TABLE deployment_new_schema (id INTEGER PRIMARY KEY)');
          migration.close();
          return undefined;
        },
        stop: async () => { await close(); pid = undefined; return undefined; }
      };
      const result = await runDeploy({ source, runtime: bot }, deps({
        service: controlled, now: () => clock, healthTimeoutMs: 1,
        sleep: async () => { clock += 1000; }, fetch: async () => Response.json({ ok: false }, { status: 503 })
      }));
      expect(result.status, result.error).toBe('rollback_failed');
      expect(ran).toEqual([result.release]);
      expect(result.previousRelease).toBe(first.release);
      expect(effects).toEqual([queued.id]);
      const recovered = open();
      recovered.runtime.setQueueHeld(true);
      await recovered.runtime.initialize([agent]);
      const execution = recovered.repos.execution.getTaskExecution(queued.id)!;
      expect(execution.task.status).toBe('completed');
      expect(execution.attempts).toHaveLength(1);
      expect(execution.currentAttempt).toEqual(completedAttempt);
      expect(await recovered.repos.config.get('after-backup')).toBe('retained');
      expect((await recovered.repos.tasks.get(addedId!))?.status).toBe('queued');
      recovered.runtime.setQueueHeld(false);
      await vi.waitFor(() => expect(recovered.repos.execution.getTaskExecution(addedId!)?.task.status).toBe('completed'));
      expect(effects).toEqual([queued.id, addedId]);
      expect(recovered.repos.execution.getTaskExecution(queued.id)!.currentAttempt).toEqual(completedAttempt);
    } finally { await close(); }
  });

  it('试加载失败时不切换、不重启，删掉这个发布目录', async () => {
    const first = await runDeploy({ source, runtime: bot }, deps());
    nextCommit(source, { versionExit: 1 });

    const result = await runDeploy({ source, runtime: bot }, deps());

    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.error).toContain('试加载');
    expect(existsSync(result.release!)).toBe(false);
    expect(realpathSync(join(releases, 'current'))).toBe(first.release);
    expect(service.ran).toEqual([first.release]);
  }, 60_000);

  it('排空时查询任务数失败则不切换、不重启', async () => {
    const first = await runDeploy({ source, runtime: bot }, deps());
    // 让正在运行的旧版本换成一个任务数查询会失败的进程
    writeFileSync(join(first.release!, 'dist', 'cli.js'), cliSource({ activity: 500 }));
    await service.restart();
    nextCommit(source);

    const result = await runDeploy({ source, runtime: bot }, deps());

    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.error).toContain('--force');
    expect(realpathSync(join(releases, 'current'))).toBe(first.release);
    expect(service.ran.every(path => path === first.release)).toBe(true);
  }, 60_000);

  it('--no-restart 只准备发布目录并切换 current', async () => {
    const result = await runDeploy({ source, runtime: bot, restart: false }, deps());
    expect(result).toMatchObject({ ok: true, status: 'staged' });
    expect(realpathSync(join(releases, 'current'))).toBe(result.release);
    expect(service.ran).toEqual([]);
  }, 60_000);

  it('配置了部署窗口时，窗口外拒绝执行，加 --now 才部署', async () => {
    const at = Date.parse('2026-09-25T03:30:00Z'); // 11:30 Asia/Shanghai
    const outside = await runDeploy({ source, runtime: bot, restart: false }, deps({ env: { DUTYDECK_DEPLOY_WINDOW: '10:00-11:00,16:00-17:00' }, now: () => at }));
    expect(outside).toMatchObject({ ok: false, status: 'refused' });
    expect(outside.error).toContain('11:30');
    expect(outside.error).toContain('--now');
    expect(existsSync(releases)).toBe(false);

    const forced = await runDeploy({ source, runtime: bot, restart: false, now: true }, deps({ env: { DUTYDECK_DEPLOY_WINDOW: '10:00-11:00' }, now: () => at }));
    expect(forced).toMatchObject({ ok: true, status: 'staged' });

    const malformed = await runDeploy({ source, runtime: bot, restart: false }, deps({ env: { DUTYDECK_DEPLOY_WINDOW: 'mornings' } }));
    expect(malformed).toMatchObject({ ok: false, status: 'refused' });
  }, 60_000);

  it('构建产物缺失或早于最新提交时拒绝部署', async () => {
    utimesSync(join(source, 'apps', 'server', 'dist', 'cli.js'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const stale = await runDeploy({ source, runtime: bot }, deps());
    expect(stale).toMatchObject({ ok: false, status: 'refused' });
    expect(stale.error).toContain('早于最新提交');

    rmSync(join(source, 'apps', 'server', 'public'), { recursive: true });
    const missing = await runDeploy({ source, runtime: bot }, deps());
    expect(missing.error).toContain('public/index.html');
    expect(service.ran).toEqual([]);
  });

  /** 在 releases 下造几个更早的发布目录，版本名按时间递增。 */
  function oldReleases(count: number) {
    return Array.from({ length: count }, (_, index) => {
      const dir = join(releases, `2026010${index + 1}T000000Z-${String(index).repeat(7)}`);
      write(join(dir, 'dist', 'cli.js'), 'x'.repeat(8192));
      return dir;
    });
  }

  it('部署成功后只留最新 5 个发布目录，current 的上一版和仍被进程引用的不删，.partial 一并清掉', async () => {
    const old = oldReleases(7);
    symlinkSync(basename(old[0]!), join(releases, 'current'));
    mkdirSync(join(releases, '.20260108T000000Z-7777777.partial'));
    mkdirSync(join(releases, 'notes'));
    // old[1] 被一个进程的命令行引用；old[2] 只出现在名字更长的另一个目录里，不算引用
    const processPaths = vi.fn(() => ['/usr/bin/node', `${old[1]}/dist/cli.js`, `dutydeck_relay_command=${old[2]}-dirty/dist/cli.js`]);

    const result = await runDeploy({ source, runtime: bot, restart: false }, deps({ processPaths }));

    expect(result, result.error).toMatchObject({ ok: true, status: 'staged', previousRelease: old[0] });
    expect(result.pruned).toMatchObject({ removed: ['.20260108T000000Z-7777777.partial', basename(old[2]!)], inUse: [basename(old[1]!)] });
    expect(result.pruned!.freedBytes).toBeGreaterThanOrEqual(8192);
    const kept = [result.release!, ...old.slice(3), old[0]!, old[1]!].map(dir => basename(dir));
    expect(readdirSync(releases).sort()).toEqual([...kept, 'current', 'notes'].sort());
    expect(JSON.parse(readFileSync(result.manifest!, 'utf8'))).toMatchObject({ pruned_releases: result.pruned!.removed, releases_in_use: [basename(old[1]!)], freed_bytes: result.pruned!.freedBytes });
  }, 60_000);

  it.skipIf(process.platform !== 'linux')('默认读 /proc：cwd 或环境变量还在旧发布目录里的进程，其目录保留', async () => {
    const old = oldReleases(8);
    const sleepers = [
      spawn('sleep', ['60'], { cwd: join(old[0]!, 'dist'), stdio: 'ignore' }),
      spawn('sleep', ['60'], { env: { ...process.env, dutydeck_relay_command: join(old[1]!, 'dist', 'cli.js') }, stdio: 'ignore' })
    ];
    try {
      await Promise.all(sleepers.map(child => new Promise(resolve => child.once('spawn', resolve))));
      const result = await runDeploy({ source, runtime: bot, restart: false }, deps());

      expect(result.pruned?.inUse.sort()).toEqual([basename(old[0]!), basename(old[1]!)]);
      expect(result.pruned?.removed.sort()).toEqual([basename(old[2]!), basename(old[3]!)]);
      expect(old.map(dir => existsSync(dir))).toEqual([true, true, false, false, true, true, true, true]);
    } finally {
      for (const child of sleepers) await stop(child);
    }
  }, 60_000);

  it('只清 deploy 自己写的旧部署记录：保留最新 5 个和上一版的，手工部署留下的不动', async () => {
    const deployments = join(bot, '.dutydeck', 'deployments');
    const [previous] = oldReleases(1);
    symlinkSync(basename(previous!), join(releases, 'current'));
    const own = Array.from({ length: 7 }, (_, index) => {
      const name = `2026010${index + 1}T000000Z-${String(index).repeat(7)}`;
      write(join(deployments, name, 'manifest.json'), JSON.stringify({ created_by: 'dutydeck deploy', status: 'deployed' }));
      write(join(deployments, name, 'dutydeck.db'), 'x'.repeat(8192));
      return name;
    });
    // 手工部署留下的：没有 manifest、manifest 不带 created_by、manifest 读不了（名字比 deploy 的记录都新）
    const manual = ['20250101T000000Z-aaaaaaa', '20250102T000000Z-bbbbbbb', '20260109T000000Z-ccccccc'];
    write(join(deployments, manual[0]!, 'database.before.sqlite'), 'manual');
    write(join(deployments, manual[1]!, 'manifest.json'), JSON.stringify({ status: 'verified' }));
    write(join(deployments, manual[2]!, 'manifest.json'), '{broken');

    const result = await runDeploy({ source, runtime: bot, restart: false }, deps());

    expect(result, result.error).toMatchObject({ ok: true, status: 'staged', previousRelease: previous });
    // 连同本次共 8 个 deploy 记录：留本次和 own[3..6]，own[0] 是上一版的记录也留下，删 own[1]、own[2]
    expect([...result.prunedRecords!.removed].sort()).toEqual([own[1], own[2]]);
    expect(result.prunedRecords!.freedBytes).toBeGreaterThanOrEqual(2 * 8192);
    expect(readdirSync(deployments).sort()).toEqual([basename(result.release!), ...own.slice(3), own[0]!, ...manual].sort());
    expect(JSON.parse(readFileSync(result.manifest!, 'utf8'))).toMatchObject({
      created_by: 'dutydeck deploy', pruned_records: result.prunedRecords!.removed, records_freed_bytes: result.prunedRecords!.freedBytes
    });
  }, 60_000);

  it('看不了运行中的进程时只清 .partial，不删旧发布目录', async () => {
    const old = oldReleases(6);
    mkdirSync(join(releases, '.x.partial'));

    const result = await runDeploy({ source, runtime: bot, restart: false }, deps({ processPaths: () => undefined }));

    expect(result.pruned).toMatchObject({ removed: ['.x.partial'], inUse: [] });
    expect(old.every(dir => existsSync(dir))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/proc'));
  }, 60_000);
});

describe('dutydeck deploy 与 systemd unit', () => {
  let tmp: string;

  beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dutydeck-deploy-unit-'))); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  function systemctl(script: string, fragmentPath: string) {
    const calls: string[] = [];
    const runCommand = async (command: string, args: readonly string[]): Promise<AutostartCommandOutput> => {
      calls.push([command, ...args].join(' '));
      if (args[1] !== 'show') return { status: 0, stdout: '', stderr: '' };
      return {
        status: 0, stderr: '',
        stdout: [
          'LoadState=loaded', 'SubState=running', 'MainPID=4242', 'Environment=PATH=/usr/bin', `WorkingDirectory=${tmp}`, `FragmentPath=${fragmentPath}`,
          `ExecStart={ path=/opt/node/bin/node ; argv[]=/opt/node/bin/node ${script} --database ${tmp}/bot.db --local-only --port 4311 ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`
        ].join('\n')
      };
    };
    return { calls, runCommand };
  }

  it('unit 还没改跑 releases/current 时拒绝部署，--print-unit 给出改写后的 unit', async () => {
    const unitFile = join(tmp, 'dutydeck-tag.service');
    const original = `[Service]\nWorkingDirectory=${tmp}\nExecStart=/opt/node/bin/node ${tmp}/runtime/dist/cli.js --database ${tmp}/bot.db --local-only --port 4311\nRestart=always\n`;
    writeFileSync(unitFile, original);
    const sys = systemctl(`${tmp}/runtime/dist/cli.js`, unitFile);
    const deps: DeployDeps = { runCommand: sys.runCommand, platform: 'linux', info: vi.fn(), warn: vi.fn() };

    const refusedResult = await runDeploy({ unit: 'dutydeck-tag.service', releases: join(tmp, 'releases'), source: join(tmp, 'nowhere') }, deps);
    expect(refusedResult).toMatchObject({ ok: false, status: 'refused' });
    expect(refusedResult.error).toContain('--print-unit');
    expect(sys.calls.some(call => call.includes(' restart '))).toBe(false);

    const printed = await runDeploy({ unit: 'dutydeck-tag.service', releases: join(tmp, 'releases'), printUnit: true }, deps);
    expect(printed).toMatchObject({ ok: true, status: 'unit', unitPath: unitFile });
    expect(printed.unitFile).toBe(original.replace(`${tmp}/runtime/dist/cli.js`, `${tmp}/releases/current/dist/cli.js`));
    expect(readFileSync(unitFile, 'utf8')).toBe(original);
  });

  it('unit 已跑 releases/current 时从 ExecStart 推出发布目录，不再以 unit 布局为由拒绝', async () => {
    const releases = join(tmp, 'releases');
    const script = join(releases, 'current', 'dist', 'cli.js');
    const unitFile = join(tmp, 'unit.service');
    writeFileSync(unitFile, `ExecStart=/opt/node/bin/node ${script} --port 4311\n`);
    const sys = systemctl(script, unitFile);
    const deps: DeployDeps = { runCommand: sys.runCommand, platform: 'linux', info: vi.fn(), warn: vi.fn() };

    const printed = await runDeploy({ unit: 'dutydeck-tag.service', printUnit: true }, deps);
    expect(printed.unitFile).toBe(`ExecStart=/opt/node/bin/node ${script} --port 4311\n`);
    const deployed = await runDeploy({ unit: 'dutydeck-tag.service', source: join(tmp, 'nowhere') }, deps);
    expect(deployed).toMatchObject({ ok: false, status: 'refused' });
    expect(deployed.error).toContain('不是 Dutydeck 检出目录');
  });
});
