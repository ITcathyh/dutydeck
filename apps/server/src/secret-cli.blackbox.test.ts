import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = join(workspaceRoot, 'apps/server/src/cli.ts');
const tsxPath = join(workspaceRoot, 'node_modules/.bin/tsx');
const roots: string[] = [];
const INITIAL_SECRET = 'INITIAL_SECRET_VALUE_NEVER_PRINT';
const ROTATED_SECRET = 'ROTATED_SECRET_VALUE_NEVER_PRINT';

function bundle(appSecret: string): string {
  return JSON.stringify({ schema_version: 1, kind: 'lark_app_credential', app_id: 'cli_secret_fixture', app_secret: appSecret });
}

function invoke(root: string, args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(tsxPath, [cliPath, '--database', join(root, 'dutydeck.db'), ...args], {
    cwd: root,
    env: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_OPTIONS: '--conditions=development', ...extraEnv },
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
