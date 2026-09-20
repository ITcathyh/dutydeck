import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { defaultDaemonDir, writeLastDaemonDir, writeState } from '../daemon/daemon.js';

const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx');
const uuid = 'dfe543ed-a565-46af-8f04-552fd038df58';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-create-cli-'));
  roots.push(root);
  const cwd = join(root, 'other-project');
  mkdirSync(cwd);
  const database = join(root, 'server', 'dutydeck.db');
  mkdirSync(dirname(database));
  return { root, cwd, database };
}

function invoke(root: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, ['--conditions=development', '--import', tsx, cli, ...args], {
    cwd, env: { HOME: root, PATH: dirname(process.execPath), NO_COLOR: '1' }, encoding: 'utf8', timeout: 10_000,
  });
}

it('finds the daemon database from another cwd and prints exactly one credential-free JSON status line', async () => {
  const { root, cwd, database } = fixture();
  const repositories = createRepositories(database);
  await repositories.config.set(`lark.app_creation.${uuid}`, JSON.stringify({ id: uuid, name: 'Bot', status: 'completed', appId: 'cli_created', botSaved: true, retryable: false, createdAt: 'now', updatedAt: 'now' }));
  await repositories.config.set('lark.bots', JSON.stringify([{ appId: 'cli_created', appSecret: 'SECRET_CANARY', listening: false, riskControlMode: 'off' }]));
  repositories.close();
  const daemon = defaultDaemonDir(join(root, 'server'));
  writeState(daemon, { pid: process.pid, ready: true, cwd: join(root, 'server'), database, startedAt: 'now' });
  writeLastDaemonDir(daemon, root);
  const result = invoke(root, cwd, ['lark', 'create', '--resume', uuid, '--status', '--json']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, job: { appId: 'cli_created', status: 'completed' } });
  expect(result.stdout + result.stderr).not.toContain('SECRET_CANARY');
  expect(result.stderr).toBe('');

  const wrongDatabase = invoke(root, cwd, ['lark', 'create', '--resume', uuid, '--status', '--json', '--database', join(root, 'separate.db')]);
  expect(wrongDatabase.status).toBe(1);
  expect(JSON.parse(wrongDatabase.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('不存在') });
});

it('exposes create in built-in help and returns a resumable login failure in noninteractive creation', () => {
  const { root, cwd, database } = fixture();
  const help = invoke(root, cwd, ['lark', 'create', '--help']);
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain('--agent <id>');
  expect(help.stdout).toContain('ccflash');
  expect(help.stdout).toContain('--force-login');
  const rejected = invoke(root, cwd, ['--database', database, 'lark', 'create', 'Bot', '--json']);
  expect(rejected.status, rejected.stderr).toBe(1);
  expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('交互终端') });
  expect(rejected.stdout.trim().split('\n')).toHaveLength(1);
  expect(rejected.stderr).toBe('');
  expect(JSON.parse(rejected.stdout).next).toContain('--resume');
  const sqlite = new Database(database, { readonly: true });
  try { expect(sqlite.prepare("SELECT count(*) AS count FROM configs WHERE key LIKE 'lark.app_creation.%'").get()).toEqual({ count: 1 }); }
  finally { sqlite.close(); }
});


it('binds a resumed bot in ask mode and reports unavailable hot-add without requesting a restart', async () => {
  const { root, cwd, database } = fixture();
  const repositories = createRepositories(database);
  await repositories.agents.save(agentConfigSchema.parse({ id: 'ccflash', name: 'CCFlash', protocol: 'pty-cli', adapterId: 'claude-code', command: process.execPath }));
  await repositories.config.set(`lark.app_creation.${uuid}`, JSON.stringify({ id: uuid, name: 'Bot', status: 'completed', appId: 'cli_created', botSaved: true, retryable: false, createdAt: 'now', updatedAt: 'now' }));
  await repositories.config.set('lark.bots', JSON.stringify([{ appId: 'cli_created', appSecret: 'SECRET_CANARY', listening: false, riskControlMode: 'off' }]));
  repositories.close();
  const result = invoke(root, cwd, ['--database', database, 'lark', 'create', '--resume', uuid, '--agent', 'ccflash', '--listen', '--json']);
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
  const read = invoke(root, cwd, ['--database', database, 'lark', 'create', '--resume', uuid, '--status', '--json']);
  expect(read.status, read.stderr).toBe(0);
  expect(JSON.parse(read.stdout)).not.toHaveProperty('listener');
  const after = new Database(database, { readonly: true });
  try { expect(after.prepare('SELECT key, value FROM configs ORDER BY key').all()).toEqual(before); }
  finally { after.close(); }
});
