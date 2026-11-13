import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { migrations } from '../../../packages/storage/src/migrations.js';
import { bundleCliForTest } from '../../../tests/support/bundle-for-test.js';

let cli: string;
let cleanup: (() => Promise<void>) | undefined;
beforeAll(async () => { ({ path: cli, cleanup } = await bundleCliForTest('schema-too-new')); }, 60_000);
afterAll(async () => { await cleanup?.(); });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))); });
});

it('a future schema error prints an exact read-only command that reports the same database without changing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-schema-too-new-')); roots.push(root);
  const scratch = join(root, 'scratch'), data = join(scratch, 'data'); mkdirSync(data, { recursive: true });
  const database = join(data, 'dutydeck.db');
  const repositories = createRepositories(database);
  repositories.close();
  const raw = new Database(database);
  raw.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (999, ?)').run(new Date().toISOString());
  raw.close();
  const env = { HOME: root, PATH: process.env.PATH, DUTYDECK_DATABASE_URL: database, DUTYDECK_DEFAULT_CWD: scratch, DUTYDECK_AGENTS_JSON: '[]', DUTYDECK_DISABLE_LARK_LISTENER: 'true' };
  const opened = spawnSync(process.execPath, [cli, '--local-only', '--port', String(await freePort()), '--no-lark-listen'], { cwd: scratch, env, encoding: 'utf8', timeout: 60_000 });
  expect(opened.status, opened.stderr).not.toBe(0);
  expect(opened.stderr).toContain('DATABASE_SCHEMA_TOO_NEW');
  expect(opened.stderr).toContain('999');
  expect(opened.stderr).toContain(String(migrations.at(-1)!.version));
  const command = `dutydeck database execution-status --database ${database}`;
  expect(opened.stderr).toContain(command);
  expect(opened.stderr).toMatch(/backup.*discards|writes.*backup/i);
  expect(opened.stderr).toMatch(/older code is not a database rollback/i);

  const digest = () => createHash('sha256').update(readFileSync(database)).digest('hex');
  const before = digest();
  const inspected = spawnSync(process.execPath, [cli, 'database', 'execution-status', '--database', database], { cwd: scratch, env, encoding: 'utf8', timeout: 60_000 });
  expect(inspected.status, inspected.stderr).toBe(0);
  expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, database, status: 'unsupported', schemaVersion: 999, unsupportedReason: 'DATABASE_SCHEMA_TOO_NEW' });
  expect(digest()).toBe(before);
}, 90_000);

it('documents the explicit read-only command and backup data-loss warning in both languages', () => {
  for (const language of ['zh', 'en']) {
    const cli = readFileSync(new URL(`../../../docs/${language}/cli.md`, import.meta.url), 'utf8');
    const upgrading = readFileSync(new URL(`../../../docs/${language}/upgrading.md`, import.meta.url), 'utf8');
    expect(cli).toContain('dutydeck database execution-status --database /path/to/runtime/dutydeck.db');
    expect(cli).toMatch(/backup restore/);
    expect(upgrading).toContain('DATABASE_SCHEMA_TOO_NEW');
    expect(upgrading).toMatch(/backup|备份/);
  }
});
