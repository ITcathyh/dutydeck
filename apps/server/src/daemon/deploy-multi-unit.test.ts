import Database from 'better-sqlite3';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { runDeploy, type DeployDeps } from './deploy.js';

it.each([false, true])('首次顺序部署共享 current 的两个 unit：第二个启动失败后恢复实际运行的 A（runtime=%s）', async useRuntime => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dutydeck-multi-unit-')));
  const source = join(base, 'checkout'), releases = join(base, 'releases');
  const write = (file: string, value: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', source, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  mkdirSync(join(source, 'node_modules/.pnpm'), { recursive: true });
  write(join(source, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  write(join(source, 'apps/server/package.json'), JSON.stringify({ name: '@byted/dutydeck', version: '1.0.0', type: 'module', dependencies: { 'better-sqlite3': '12.11.1' } }));
  for (const name of ['claude-acp.mjs', 'env-launcher.mjs']) write(join(source, 'apps/server/dist/agents', name), '');
  write(join(source, 'apps/server/public/index.html'), '<html/>');
  write(join(source, 'tracked'), 'A');
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'A');
  // 复制真实 pnpm 安装的生产依赖闭包，让 runDeploy 按标准打包路径生成独立发布目录。
  const require = createRequire(import.meta.url);
  const installed = dirname(dirname(dirname(require.resolve('better-sqlite3/package.json'))));
  const store = dirname(installed), copied = new Set<string>();
  const copyEntry = (entry: string) => {
    if (copied.has(entry)) return;
    copied.add(entry);
    cpSync(join(store, entry), join(source, 'node_modules/.pnpm', entry), { recursive: true, verbatimSymlinks: true });
    const modules = join(store, entry, 'node_modules');
    for (const name of readdirSync(modules, { withFileTypes: true })) {
      if (name.isSymbolicLink()) copyEntry(relative(store, realpathSync(join(modules, name.name))).split('/')[0]!);
    }
  };
  copyEntry(basename(installed));
  mkdirSync(join(source, 'apps/server/node_modules'), { recursive: true });
  symlinkSync(`../../../node_modules/.pnpm/${basename(installed)}/node_modules/better-sqlite3`, join(source, 'apps/server/node_modules/better-sqlite3'));
  const build = (version: string) => write(join(source, 'apps/server/dist/cli.js'), `import { createServer } from 'node:http';
import Database from 'better-sqlite3';
if(process.argv.includes('--version')){console.log('1.0.0');process.exit(0);}
const db=new Database(process.argv[process.argv.indexOf('--database')+1]);
const version=${JSON.stringify(version)},bot=process.argv[2],port=Number(process.argv[3]);
if(version==='B'&&bot==='two')process.exit(12);
createServer((req,res)=>{const path=new URL(req.url,'http://x').pathname;
res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(path==='/health'?{ok:true,version}:path==='/api/system/activity'?{runningTasks:0}:{draining:true}));}).listen(port,'127.0.0.1');
process.on('SIGTERM',()=>process.exit(0));\n`);
  build('A');
  const freePort = async () => await new Promise<number>(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
  const stop = async (child: ChildProcess | undefined) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM'); await done;
  };
  const makeService = async (bot: string) => {
    const port = await freePort(), root = join(base, bot), database = join(root, 'state.db');
    mkdirSync(root);
    const db = new Database(database); db.exec('CREATE TABLE configs(key TEXT PRIMARY KEY,value TEXT)'); db.close();
    write(join(root, 'deployment.json'), JSON.stringify({ unit: `dutydeck-${bot}.service`, address: `http://127.0.0.1:${port}`, databasePath: database }));
    let child: ChildProcess | undefined;
    const ran: string[] = [];
    return {
      bot, root, database, port, ran,
      mainPid: async () => child && child.exitCode === null && child.signalCode === null ? child.pid : undefined,
      restart: async () => {
        await stop(child);
        ran.push(realpathSync(join(releases, 'current')));
        child = spawn(process.execPath, [join(releases, 'current/dist/cli.js'), bot, String(port), '--port', String(port), '--database', database, '--local-only'], { cwd: root, stdio: 'ignore', env: { PATH: process.env.PATH } });
      },
      stop: async () => await stop(child),
      health: async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          try { return await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { version: string }; }
          catch { await new Promise(resolve => setTimeout(resolve, 10)); }
        }
        throw new Error('Fixture did not start');
      }
    };
  };
  const one = await makeService('one'), two = await makeService('two');
  const services: Record<string, typeof one> = { 'dutydeck-one.service': one, 'dutydeck-two.service': two };
  const deps: DeployDeps = {
    platform: 'linux', env: {}, checkSqlite: () => ({ ok: true, execPath: process.execPath }),
    info: () => {}, warn: () => {}, readToken: () => undefined, healthTimeoutMs: 300,
    sleep: async () => { await new Promise(resolve => setTimeout(resolve, 20)); },
    runCommand: async (command, args) => {
      expect(command).toBe('systemctl'); expect(args[0]).toBe('--user');
      const service = services[args[2]!]; expect(service).toBeDefined();
      if (args[1] === 'show') return { status: 0, stderr: '', stdout: [
        'LoadState=loaded', `MainPID=${await service.mainPid() ?? 0}`, `WorkingDirectory=${service.root}`, 'Environment=', 'KillMode=process',
        `ExecStart={ path=${process.execPath} ; argv[]=${process.execPath} ${join(releases, 'current/dist/cli.js')} ${service.bot} ${service.port} --port ${service.port} --database ${service.database} --local-only ; ignore_errors=no ; }`
      ].join('\n') };
      if (args[1] === 'restart') await service.restart();
      else if (args[1] === 'stop') await service.stop();
      else expect(args[1]).toBe('reset-failed');
      return { status: 0, stdout: '', stderr: '' };
    }
  };
  try {
    const original = await runDeploy({ source, unit: 'dutydeck-one.service', restart: false }, deps);
    expect(original.status, original.error).toBe('staged');
    await one.restart(); await two.restart();
    expect((await one.health()).version).toBe('A'); expect((await two.health()).version).toBe('A');
    const maps = readFileSync(`/proc/${await two.mainPid()}/maps`, 'utf8');
    expect(maps).toContain(join(original.release!, 'node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
    write(join(source, 'tracked'), 'B'); git('commit', '-qam', 'B'); build('B');
    const first = await runDeploy({ source, unit: 'dutydeck-one.service' }, deps);
    expect(first.status, first.error).toBe('deployed');
    expect((await two.health()).version).toBe('A');
    // 再部署 unit1 时，它的 previous 已是 B；尚无 unit 记录的旧 unit2 只能由实际进程映射保护 A。
    for (let index = 0; index < 6; index++) mkdirSync(join(releases, `20271001T10000${index}Z-abcdef0`));
    const repeated = await runDeploy({ source, unit: 'dutydeck-one.service' }, deps);
    expect(repeated.status, repeated.error).toBe('deployed');
    expect(repeated.pruned?.inUse).toContain(basename(original.release!));
    expect(existsSync(original.release!)).toBe(true);
    const second = await runDeploy({ source, ...(useRuntime ? { runtime: two.root } : { unit: 'dutydeck-two.service' }) }, deps);
    expect(second.status, second.error).toBe('rolled_back');
    expect(second.previousRelease).toBe(original.release);
    expect(two.ran).toEqual([original.release, second.release, original.release]);
    expect((await two.health()).version).toBe('A');
    expect((await one.health()).version).toBe('B');
    const manifest = JSON.parse(readFileSync(second.manifest!, 'utf8'));
    expect(manifest.schema_fingerprint_at_rollback).toBe(manifest.schema_fingerprint_before);
    expect(manifest).toMatchObject({ database_restored: false, rollback_service_stopped: true });
  } finally { await one.stop(); await two.stop(); rmSync(base, { recursive: true, force: true }); }
}, 20_000);
