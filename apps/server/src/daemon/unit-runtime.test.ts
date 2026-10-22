import { resolveDatabaseUrl } from '@dutydeck/config';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerAuthMiddleware } from '../auth/auth.js';
import { createCliProgram, environmentFromCli, type CliOptions } from '../cli-program.js';
import { daemonRestart, unitRuntime } from './command.js';
import { defaultDaemonDir, writeState } from './daemon.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dutydeck-unit-runtime-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

function unit(args: string[] = [], environment: NodeJS.ProcessEnv = {}) {
  let pid = 1001;
  const runCommand = vi.fn(async (_command: string, commandArgs: readonly string[]) => {
    if (commandArgs[1] === 'restart') { pid = 1002; return { status: 0, stderr: '', stdout: '' }; }
    expect(commandArgs[1]).toBe('show');
    return { status: 0, stderr: '', stdout: [
      'LoadState=loaded', 'SubState=running', `MainPID=${pid}`, `WorkingDirectory=${root}`,
      `Environment=${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join(' ')}`,
      `ExecStart={ path=${process.execPath} ; argv[]=${process.execPath} ${root}/dist/cli.js ${args.join(' ')} ; ignore_errors=no ; }`
    ].join('\n') };
  });
  return { runCommand, platform: 'linux' as const };
}

it.each([
  { args: [], env: { DUTYDECK_DATABASE_URL: 'custom.db' }, expected: 'custom.db' },
  { args: [], env: { DUTYDECK_DATABASE_URL: '/tmp/explicit-unit.db' }, expected: '/tmp/explicit-unit.db' },
  { args: ['--database', 'flag.db'], env: { DUTYDECK_DATABASE_URL: 'custom.db' }, expected: 'flag.db' },
  { args: ['--database=flag.db'], env: { DUTYDECK_DATABASE_URL: 'custom.db' }, expected: 'flag.db' },
  { args: [], env: {}, expected: '.dutydeck/dutydeck.db' },
  { args: [], env: { DUTYDECK_DEFAULT_CWD: 'workspace', DUTYDECK_DATABASE_URL: 'custom.db' }, expected: 'workspace/custom.db' },
  { args: ['--cwd', 'from-flag'], env: { DUTYDECK_DEFAULT_CWD: 'workspace', DUTYDECK_DATABASE_URL: 'custom.db' }, expected: 'from-flag/custom.db' },
  { args: ['--cwd=from-flag'], env: {}, expected: 'from-flag/.dutydeck/dutydeck.db' }
])('matches the root CLI database resolution: $args / $env', async ({ args, env, expected }) => {
  let options: CliOptions | undefined;
  const program = createCliProgram('test', { serve: value => { options = value; } });
  await program.parseAsync([process.execPath, join(root, 'dist/cli.js'), ...args]);
  expect(options).toBeDefined();
  const actualEnvironment = environmentFromCli(options!, env);
  // The real service process starts with WorkingDirectory as process.cwd().
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const database = resolveDatabaseUrl(actualEnvironment);
  expect(database).toBe(resolve(root, expected));
  const target = await unitRuntime('dutydeck-fixture.service', unit(args, env));
  expect(target).toMatchObject({ foreground: false, endpoint: { database } });
});

it.each([
  { args: [], env: {}, database: 'file workspace/file.db', port: 4901, authEnabled: false },
  { args: [], env: { DUTYDECK_DATABASE_URL: 'unit.db', DUTYDECK_PORT: '4902', DUTYDECK_AUTH: 'true' }, database: 'file workspace/unit.db', port: 4902, authEnabled: true },
  { args: ['--cwd', 'flag-workspace', '--database', 'flag.db', '--port', '4903', '--unsafe-no-auth'], env: { DUTYDECK_DATABASE_URL: 'unit.db', DUTYDECK_PORT: '4902', DUTYDECK_AUTH: 'true' }, database: 'flag-workspace/flag.db', port: 4903, authEnabled: false },
  { args: ['--host', '0.0.0.0'], env: {}, database: 'file workspace/file.db', port: 4901, authEnabled: false },
  { args: ['--port', '4902', '--port=4903', '--no-auth', '--auth'], env: {}, database: 'file workspace/file.db', port: 4903, authEnabled: true }
])('matches real Node .env loading and root CLI overrides: $args / $env', async ({ args, env, database, port, authEnabled }) => {
  writeFileSync(join(root, '.env'), 'export DUTYDECK_DEFAULT_CWD="file workspace"\nDUTYDECK_DATABASE_URL="file.db"\nDUTYDECK_PORT=4901\nDUTYDECK_AUTH=false\nDUTYDECK_LOCAL_ONLY=true\nUNRELATED_SECRET="fixture\nsecret"\n');
  const loaded = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', 'import { loadEnvFile } from "node:process"; loadEnvFile(); console.log(JSON.stringify(process.env));'], { cwd: root, env, encoding: 'utf8' }));
  let options: CliOptions | undefined;
  await createCliProgram('test', { serve: value => { options = value; } }).parseAsync([process.execPath, join(root, 'dist/cli.js'), ...args]);
  const expected = environmentFromCli(options!, loaded);
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const controllerEnv = { ...process.env };
  const target = await unitRuntime('dutydeck-fixture.service', unit(args, env));
  expect(resolveDatabaseUrl(expected)).toBe(resolve(root, database));
  expect(target).toMatchObject({ foreground: false, endpoint: { database: resolveDatabaseUrl(expected), address: `http://127.0.0.1:${port}`, authEnabled } });
  expect(process.env).toEqual(controllerEnv);
});

it('refuses an unreadable target .env without falling back to controller configuration', async () => {
  mkdirSync(join(root, '.env'));
  const world = unit();
  const result = await daemonRestart({ unit: 'dutydeck-fixture.service' }, { ...world, serve: vi.fn(), checkSqlite: vi.fn(), fetch: vi.fn() });
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining(join(root, '.env')) });
  expect(result.error).toContain('EISDIR');
  expect(world.runCommand.mock.calls.filter(([, args]) => args[1] === 'restart')).toHaveLength(0);
});

it.each([
  ['DUTYDECK_PORT', 'credential-invalid-port'],
  ['DUTYDECK_AUTH', 'credential-invalid-auth'],
  ['DUTYDECK_DATABASE_URL', 'credential\0invalid-path']
])('refuses invalid critical configuration without exposing its value: %s', async (key, value) => {
  writeFileSync(join(root, '.env'), `${key}=${value}\n`);
  const result = await unitRuntime('dutydeck-fixture.service', unit());
  expect(result).toMatchObject({ error: expect.stringContaining('已拒绝操作') });
  expect(JSON.stringify(result)).not.toContain('credential');
  expect(JSON.stringify(result)).toContain(join(root, '.env'));
});

it('validates critical configuration after applying unit and flag overrides', async () => {
  writeFileSync(join(root, '.env'), 'DUTYDECK_PORT=invalid\nDUTYDECK_AUTH=invalid\nDUTYDECK_DATABASE_URL=invalid\0path\n');
  const result = await unitRuntime('dutydeck-fixture.service', unit(['--database', 'flag.db'], { DUTYDECK_PORT: '4901', DUTYDECK_AUTH: 'true' }));
  expect(result).toMatchObject({ endpoint: { database: join(root, 'flag.db'), address: 'http://127.0.0.1:4901', authEnabled: true } });
});

it('keeps foreground daemon state authoritative over CLI flags and environment', async () => {
  const database = join(root, 'state.db');
  mkdirSync(join(root, '.env'));
  writeState(defaultDaemonDir(root), { pid: 1001, ready: true, startedAt: 'test', cwd: root, database, address: 'http://127.0.0.1:4900', authEnabled: false });
  const target = await unitRuntime('dutydeck-fixture.service', unit(['start', '--foreground', '--database', 'flag.db'], { DUTYDECK_DATABASE_URL: 'custom.db' }));
  expect(target).toMatchObject({ foreground: true, endpoint: { database, address: 'http://127.0.0.1:4900', authEnabled: false } });
});

it.each(['unit-env', 'env-file'])('authenticates drain and activity against the %s database before an isolated restart', async source => {
  const database = join(root, 'custom.db');
  const db = new Database(database);
  db.exec('CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO configs VALUES (?, ?)').run('auth.accessToken', 'fixture-token');
  db.close();
  const app = Fastify();
  registerAuthMiddleware(app, { localOnly: false, mode: 'token', getToken: async () => 'fixture-token', exempt: (_method, path) => path === '/health' });
  app.post('/api/system/drain', async () => ({ draining: true }));
  app.get('/api/system/activity', async () => ({ runningTasks: 0 }));
  app.get('/health', async () => ({ ok: true }));
  const statuses: number[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const response = await app.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url: new URL(String(input)).pathname, headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body ? { payload: String(init.body) } : {}) });
    statuses.push(response.statusCode);
    return new Response(response.body, { status: response.statusCode });
  };
  if (source === 'env-file') writeFileSync(join(root, '.env'), `DUTYDECK_DATABASE_URL=${database}\nDUTYDECK_HOST=0.0.0.0\n`);
  const world = unit([], source === 'unit-env' ? { DUTYDECK_DATABASE_URL: database, DUTYDECK_HOST: '0.0.0.0' } : {});
  try {
    const result = await daemonRestart({ unit: 'dutydeck-fixture.service' }, {
      ...world, serve: vi.fn(), checkSqlite: () => ({ ok: true, execPath: process.execPath }),
      fetch: fetcher, sleep: async () => {}, info: vi.fn(), warn: vi.fn()
    });
    expect(result).toMatchObject({ ok: true, state: 'restarted', pid: 1002 });
    expect(statuses.length).toBeGreaterThanOrEqual(3);
    expect(statuses.every(status => status === 200)).toBe(true);
    expect(world.runCommand.mock.calls.filter(([, args]) => args[1] === 'restart')).toHaveLength(1);
  } finally { await app.close(); }
});
