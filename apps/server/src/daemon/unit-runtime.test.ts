import { resolveDatabaseUrl } from '@dutydeck/config';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
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

it('keeps foreground daemon state authoritative over CLI flags and environment', async () => {
  const database = join(root, 'state.db');
  writeState(defaultDaemonDir(root), { pid: 1001, ready: true, startedAt: 'test', cwd: root, database, address: 'http://127.0.0.1:4900', authEnabled: false });
  const target = await unitRuntime('dutydeck-fixture.service', unit(['start', '--foreground', '--database', 'flag.db'], { DUTYDECK_DATABASE_URL: 'custom.db' }));
  expect(target).toMatchObject({ foreground: true, endpoint: { database, address: 'http://127.0.0.1:4900', authEnabled: false } });
});

it('authenticates drain and activity against the environment-only database before an isolated restart', async () => {
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
  const world = unit([], { DUTYDECK_DATABASE_URL: database, DUTYDECK_HOST: '0.0.0.0' });
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
