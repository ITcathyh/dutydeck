import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { it, type TestContext } from 'vitest';
import Database from 'better-sqlite3';
import { createRepositories, currentProcessIdentity } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { defaultDaemonDir, writeLastDaemonDir, writeState } from '../daemon/daemon.js';

const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');
const uuid = 'dfe543ed-a565-46af-8f04-552fd038df58';

function fixture(onTestFinished: TestContext['onTestFinished']) {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-create-cli-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'other-project');
  mkdirSync(cwd);
  const database = join(root, 'server', 'dutydeck.db');
  mkdirSync(dirname(database));
  return { root, cwd, database };
}

// 每次调用都是冷启动 tsx 子进程，互不依赖的调用并发跑；三个用例各用独立 HOME 与数据库，也并发执行。
function invoke(root: string, cwd: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=development', '--import', tsx, cli, ...args], {
      cwd, env: { HOME: root, PATH: dirname(process.execPath), NO_COLOR: '1' }, timeout: 10_000,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

it.concurrent('finds the daemon database from another cwd and prints exactly one credential-free JSON status line', async ({ expect, onTestFinished }) => {
  const { root, cwd, database } = fixture(onTestFinished);
  const repositories = createRepositories(database);
  await repositories.config.set(`lark.app_creation.${uuid}`, JSON.stringify({ id: uuid, name: 'Bot', status: 'completed', appId: 'cli_created', botSaved: true, retryable: false, createdAt: 'now', updatedAt: 'now' }));
  await repositories.config.set('lark.bots', JSON.stringify([{ appId: 'cli_created', appSecret: 'SECRET_CANARY', listening: false, riskControlMode: 'off' }]));
  repositories.close();
  const daemon = defaultDaemonDir(join(root, 'server'));
  writeState(daemon, { pid: process.pid, processIdentity: currentProcessIdentity(), ready: true, cwd: join(root, 'server'), database, startedAt: 'now' });
  writeLastDaemonDir(daemon, root);
  const [result, wrongDatabase] = await Promise.all([
    invoke(root, cwd, ['lark', 'create', '--resume', uuid, '--status', '--json']),
    invoke(root, cwd, ['lark', 'create', '--resume', uuid, '--status', '--json', '--database', join(root, 'separate.db')]),
  ]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, job: { appId: 'cli_created', status: 'completed' } });
  expect(result.stdout + result.stderr).not.toContain('SECRET_CANARY');
  expect(result.stderr).toBe('');

  expect(wrongDatabase.status).toBe(1);
  expect(JSON.parse(wrongDatabase.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('不存在') });
});

it.concurrent('exposes create in built-in help and returns a resumable login failure in noninteractive creation', async ({ expect, onTestFinished }) => {
  const { root, cwd, database } = fixture(onTestFinished);
  const [help, rejected] = await Promise.all([
    invoke(root, cwd, ['lark', 'create', '--help']),
    invoke(root, cwd, ['--database', database, 'lark', 'create', 'Bot', '--json']),
  ]);
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain('--agent <id>');
  expect(help.stdout).toContain('ccflash');
  expect(help.stdout).toContain('--force-login');
  expect(rejected.status, rejected.stderr).toBe(1);
  expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('交互终端') });
  expect(rejected.stdout.trim().split('\n')).toHaveLength(1);
  expect(rejected.stderr).toBe('');
  expect(JSON.parse(rejected.stdout).next).toContain('--resume');
  const sqlite = new Database(database, { readonly: true });
  try { expect(sqlite.prepare("SELECT count(*) AS count FROM configs WHERE key LIKE 'lark.app_creation.%'").get()).toEqual({ count: 1 }); }
  finally { sqlite.close(); }
});

it.concurrent('binds a resumed bot in ask mode and reports unavailable hot-add without requesting a restart', async ({ expect, onTestFinished }) => {
  const { root, cwd, database } = fixture(onTestFinished);
  const repositories = createRepositories(database);
  await repositories.agents.save(agentConfigSchema.parse({ id: 'ccflash', name: 'CCFlash', protocol: 'pty-cli', adapterId: 'claude-code', command: process.execPath }));
  await repositories.config.set(`lark.app_creation.${uuid}`, JSON.stringify({ id: uuid, name: 'Bot', status: 'completed', appId: 'cli_created', botSaved: true, retryable: false, createdAt: 'now', updatedAt: 'now' }));
  await repositories.config.set('lark.bots', JSON.stringify([{ appId: 'cli_created', appSecret: 'SECRET_CANARY', listening: false, riskControlMode: 'off' }]));
  repositories.close();
  const result = await invoke(root, cwd, ['--database', database, 'lark', 'create', '--resume', uuid, '--agent', 'ccflash', '--listen', '--json']);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, job: { status: 'completed' }, bot: { permissionMode: 'ask', fullTrustConfirmed: false, listening: true, activeListening: false }, listener: { activeListening: false }, next: expect.stringContaining('启动服务') });
  expect(result.stdout).not.toContain('restartRequired');
  expect(result.stdout + result.stderr).not.toContain('SECRET_CANARY');
  expect(result.stderr).toBe('');
  const sqlite = new Database(database, { readonly: true });
  let before: unknown;
  try { before = sqlite.prepare('SELECT key, value FROM configs ORDER BY key').all(); }
  finally { sqlite.close(); }
  const read = await invoke(root, cwd, ['--database', database, 'lark', 'create', '--resume', uuid, '--status', '--json']);
  expect(read.status, read.stderr).toBe(0);
  expect(JSON.parse(read.stdout)).not.toHaveProperty('listener');
  const after = new Database(database, { readonly: true });
  try { expect(after.prepare('SELECT key, value FROM configs ORDER BY key').all()).toEqual(before); }
  finally { after.close(); }
});
