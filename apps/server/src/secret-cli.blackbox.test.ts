import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bundleCliForTest } from '../../../tests/support/bundle-for-test.js';
import { liveLarkSecretKey } from '@dutydeck/secret-provider';
import { readLarkConfigs, saveLarkConfig } from './lark/config.js';
import { createRepositories } from '@dutydeck/storage';

let bundledCliPath: string;

// Compile this checkout once: repeated TypeScript loader + dependency cold starts
// otherwise consume most of the test budget before secret operations begin.
let cleanupCli: (() => Promise<void>) | undefined;
beforeAll(async () => { ({ path: bundledCliPath, cleanup: cleanupCli } = await bundleCliForTest('secret-cli')); });
afterAll(async () => { await cleanupCli?.(); });
const roots: string[] = [];
const INITIAL_SECRET = 'INITIAL_SECRET_VALUE_NEVER_PRINT';
const ROTATED_SECRET = 'ROTATED_SECRET_VALUE_NEVER_PRINT';

function bundle(appSecret: string): string {
  return JSON.stringify({ schema_version: 1, kind: 'lark_app_credential', app_id: 'cli_secret_fixture', app_secret: appSecret });
}

function invoke(root: string, args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bundledCliPath, '--database', join(root, 'dutydeck.db'), ...args], {
    cwd: root,
    env: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_COMPILE_CACHE: join(dirname(bundledCliPath), 'compile-cache'), ...extraEnv },
    encoding: 'utf8',
    input,
    timeout: 30_000
  });
}

function expectNoValues(result: ReturnType<typeof invoke>): void {
  expect(`${result.stdout}${result.stderr}`).not.toContain(INITIAL_SECRET);
  expect(`${result.stdout}${result.stderr}`).not.toContain(ROTATED_SECRET);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-secret-cli-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('dutydeck secret CLI black box', () => {
  it('migrates live bots one at a time, resolves them after reopen and restores legacy JSON', async () => {
    const root = await fixture();
    const database = join(root, 'dutydeck.db');
    const seed = createRepositories(database);
    const bots = [{ appId: 'cli_one', appSecret: INITIAL_SECRET }, { appId: 'cli_two', appSecret: ROTATED_SECRET }];
    await seed.config.set('lark.bots', JSON.stringify(bots));
    seed.close();
    const command = (...flags: string[]) => {
      const result = invoke(root, ['secret', 'migrate-lark', ...flags]);
      expectNoValues(result);
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout).appIds;
    };
    expect(command('--dry-run')).toEqual(['cli_one', 'cli_two']);
    await expect(lstat(join(root, 'secrets'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(command()).toEqual(['cli_one', 'cli_two']);
    expect(command()).toEqual([]);
    const report = invoke(root, ['doctor', '--json'], undefined, { DUTYDECK_DATABASE_URL: database });
    expectNoValues(report);
    expect(JSON.parse(report.stdout).checks.find((check: { id: string }) => check.id === 'lark.config')).toMatchObject({ level: 'ok' });
    const repos = createRepositories(database);
    try {
      const raw = async () => JSON.parse((await repos.config.get('lark.bots'))!);
      const migrated = await raw();
      expect(migrated.every((bot: any) => bot.appSecret === undefined && typeof bot.appSecretRef === 'string')).toBe(true);
      await repos.config.set('lark.bots', JSON.stringify([{ ...migrated[0], appSecret: ROTATED_SECRET }, migrated[1]]));
      expect((await readLarkConfigs(repos.config)).map(bot => bot.appSecret)).toEqual([INITIAL_SECRET, ROTATED_SECRET]);
      const mismatch = invoke(root, ['secret', 'migrate-lark']);
      expectNoValues(mismatch);
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain('SECRET_CONDITION_FAILED');
      expect((await raw())[0].appSecret === ROTATED_SECRET).toBe(true);
      await saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_two', appSecret: INITIAL_SECRET });
      expect((await raw())[1]).toMatchObject({ appSecret: INITIAL_SECRET });
      expect((await raw())[1]).not.toHaveProperty('appSecretRef');
      expect(command('--dry-run', '--revert')).toEqual(['cli_one']);
      expect(command('--revert')).toEqual(['cli_one']);
      expect(command('--revert')).toEqual([]);
      expect((await raw()).map((bot: any) => bot.appSecret)).toEqual([INITIAL_SECRET, INITIAL_SECRET]);
    } finally { repos.close(); }
  });

  it('uses inline credentials when a referenced file is missing and preserves other bots on save', async () => {
    const root = await fixture();
    const repos = createRepositories(join(root, 'dutydeck.db'));
    try {
      await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_one', appSecret: INITIAL_SECRET }, { appId: 'cli_two', appSecret: ROTATED_SECRET }]));
      const result = invoke(root, ['secret', 'migrate-lark']);
      expect(result.status, result.stderr).toBe(0);
      const migrated = JSON.parse((await repos.config.get('lark.bots'))!);
      const missing = migrated[0];
      await rm(join(root, 'secrets', liveLarkSecretKey(missing.appId, missing.appSecretRef) + '.secret'));
      await saveLarkConfig(repos.config, repos.agents, { originalAppId: 'cli_two', name: 'Updated' });
      const saved = JSON.parse((await repos.config.get('lark.bots'))!);
      expect(saved.find((bot: { appId: string }) => bot.appId === 'cli_one')).toEqual(missing);
      expect(saved.find((bot: { appId: string }) => bot.appId === 'cli_two').appSecret === ROTATED_SECRET).toBe(true);
      await repos.config.set('lark.bots', JSON.stringify([{ ...missing, appSecret: INITIAL_SECRET }]));
      expect((await readLarkConfigs(repos.config))[0]?.appSecret === INITIAL_SECRET).toBe(true);
    } finally { repos.close(); }
  });

  it('preserves progress and plaintext on a provider write failure without disclosing values', async () => {
    const root = await fixture();
    const repos = createRepositories(join(root, 'dutydeck.db'));
    try {
      const oversized = ROTATED_SECRET.repeat(5000);
      await repos.config.set('lark.bots', JSON.stringify([{ appId: 'cli_one', appSecret: INITIAL_SECRET }, { appId: 'cli_two', appSecret: oversized }]));
      const result = invoke(root, ['secret', 'migrate-lark']);
      expectNoValues(result);
      expect(result.status).toBe(1);
      const raw = JSON.parse((await repos.config.get('lark.bots'))!);
      expect(raw[0]).not.toHaveProperty('appSecret');
      expect(raw[1].appSecret === oversized).toBe(true);
      expect((await readLarkConfigs(repos.config, { readOnly: true }))[0]?.appSecret === INITIAL_SECRET).toBe(true);
    } finally { repos.close(); }
  });

  it('sets, lists and rotates using fd input while outputting metadata only', async () => {
    const root = await fixture();
    const created = invoke(root, ['secret', 'set', 'team-bot', '--value-fd', '0'], bundle(INITIAL_SECRET));
    expect(created.status, created.stderr).toBe(0);
    expectNoValues(created);
    const createdJson = JSON.parse(created.stdout);
    expect(createdJson).toMatchObject({ ok: true, secretRef: { id: 'team-bot', revision: 1, kind: 'lark_app_secret', provider: 'local-file-v1', status: 'configured', availability: 'available' } });
    expect(createdJson.secretRef).not.toHaveProperty('value');
    expect(createdJson.secretRef).not.toHaveProperty('app_secret');

    const directory = join(root, 'secrets');
    if (process.platform !== 'win32') expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    const firstFiles = (await readdir(directory)).filter(name => name.endsWith('.secret'));
    expect(firstFiles).toHaveLength(1);
    if (process.platform !== 'win32') expect((await lstat(join(directory, firstFiles[0]!))).mode & 0o777).toBe(0o600);

    const listed = invoke(root, ['secret', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    expectNoValues(listed);
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, secretRefs: [{ id: 'team-bot', revision: 1, availability: 'available' }] });

    const rotated = invoke(root, ['secret', 'rotate', 'team-bot', '--expected-revision', '1', '--value-fd', '0'], bundle(ROTATED_SECRET));
    expect(rotated.status, rotated.stderr).toBe(0);
    expectNoValues(rotated);
    expect(JSON.parse(rotated.stdout)).toMatchObject({ ok: true, secretRef: { id: 'team-bot', revision: 2, availability: 'available' } });
    expect((await readdir(directory)).filter(name => name.endsWith('.secret'))).toHaveLength(1);
    const onlyValue = await readFile(join(directory, (await readdir(directory)).find(name => name.endsWith('.secret'))!));
    expect(onlyValue.toString('utf8')).toContain(ROTATED_SECRET);
    expect(onlyValue.toString('utf8')).not.toContain(INITIAL_SECRET);
    onlyValue.fill(0);

    const stale = invoke(root, ['secret', 'rotate', 'team-bot', '--expected-revision', '1', '--value-fd', '0'], bundle(INITIAL_SECRET));
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain('FOUNDATION_REVISION_CONFLICT');
    expectNoValues(stale);
  });

  it('refuses removal while referenced and preserves both metadata and value', async () => {
    const root = await fixture();
    const created = invoke(root, ['secret', 'set', 'referenced', '--value-fd', '0'], bundle(INITIAL_SECRET));
    expect(created.status, created.stderr).toBe(0);
    const metadata = JSON.parse(created.stdout).secretRef as { referenceKey: string };
    const repositories = createRepositories(join(root, 'dutydeck.db'));
    await repositories.channelBots.create({ id: 'uses-secret', channel: 'lark', externalAppId: 'cli_uses_secret', displayName: 'Uses Secret', brand: 'feishu', credentialRef: 'referenced', state: 'staged' });
    repositories.close();

    const rejected = invoke(root, ['secret', 'remove', 'referenced', '--expected-revision', '1']);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('FOUNDATION_SECRET_REF_REFERENCED');
    expectNoValues(rejected);
    expect((await lstat(join(root, 'secrets', `${metadata.referenceKey}.secret`))).isFile()).toBe(true);
    const listed = invoke(root, ['secret', 'list']);
    expect(JSON.parse(listed.stdout).secretRefs).toEqual([expect.objectContaining({ id: 'referenced', availability: 'available' })]);

    const detached = createRepositories(join(root, 'dutydeck.db'));
    await detached.channelBots.update('uses-secret', { expectedRevision: 1, credentialRef: null });
    detached.close();
    const removed = invoke(root, ['secret', 'remove', 'referenced', '--expected-revision', '1']);
    expect(removed.status, removed.stderr).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ secretRef: { id: 'referenced', revision: 1, availability: 'missing' } });
    await expect(lstat(join(root, 'secrets', `${metadata.referenceKey}.secret`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(invoke(root, ['secret', 'list']).stdout).secretRefs).toEqual([]);
  });

  it('rejects argv/env values and reports a symlinked value as unreadable without following it', async () => {
    const root = await fixture();
    const argv = invoke(root, ['secret', 'set', 'argv-ref', '--value', INITIAL_SECRET]);
    expect(argv.status).not.toBe(0);
    expect(argv.stderr).toContain('unknown option');
    expectNoValues(argv);
    const env = invoke(root, ['secret', 'set', 'env-ref'], undefined, { DUTYDECK_SECRET_VALUE: INITIAL_SECRET });
    expect(env.status).not.toBe(0);
    expect(env.stderr).toContain('SECRET_VALUE_INPUT_REQUIRED');
    expectNoValues(env);

    const created = invoke(root, ['secret', 'set', 'linked-ref', '--value-fd', '0'], bundle(INITIAL_SECRET));
    expect(created.status, created.stderr).toBe(0);
    const referenceKey = JSON.parse(created.stdout).secretRef.referenceKey as string;
    const valuePath = join(root, 'secrets', `${referenceKey}.secret`);
    await rm(valuePath);
    const target = join(root, 'outside-target');
    await writeFile(target, 'unchanged', { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(target, 0o600);
    await symlink(target, valuePath);
    const listed = invoke(root, ['secret', 'list']);
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ secretRefs: [{ id: 'linked-ref', availability: 'unreadable' }] });
    expect(await readFile(target, 'utf8')).toBe('unchanged');
    expectNoValues(listed);
  });
});
