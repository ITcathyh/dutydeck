import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LarkIdentityPreflightSecretBoundary,
  LarkListenerSecretBoundary,
  LocalFileLarkCredentialResolver,
  LocalFileSecretProvider,
  SecretProviderError,
  secretDirectoryForDatabase
} from './index.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
const bundle = () => Buffer.from(JSON.stringify({ schema_version: 1, kind: 'lark_app_credential', app_id: 'cli_fixture', app_secret: 'SECRET_CANARY' }));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-secrets-'));
  roots.push(root);
  const directory = join(root, 'secrets');
  return { root, directory, provider: new LocalFileSecretProvider(directory, { createDirectory: true }) };
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('LocalFileSecretProvider', () => {
  it('creates private directories and files with exclusive atomic writes and zeroes input', async () => {
    const { directory, provider } = await fixture();
    const value = bundle();
    const result = provider.writeExclusive('lark.ref-1', value);
    expect(value.every(byte => byte === 0)).toBe(true);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.inspect('lark.ref-1')).toEqual({ referenceKey: 'lark.ref-1', availability: 'available' });
    if (process.platform !== 'win32') {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(directory, 'lark.ref-1.secret'))).mode & 0o777).toBe(0o600);
      expect((await lstat(join(directory, 'lark.ref-1.secret'))).nlink).toBe(1);
    }
    const second = bundle();
    expect(() => provider.writeExclusive('lark.ref-1', second)).toThrowError(expect.objectContaining({ code: 'SECRET_ALREADY_EXISTS' }));
    expect(second.every(byte => byte === 0)).toBe(true);
    const invalid = bundle();
    expect(() => provider.writeExclusive('../escape', invalid)).toThrowError(expect.objectContaining({ code: 'SECRET_REFERENCE_KEY_INVALID' }));
    expect(invalid.every(byte => byte === 0)).toBe(true);
  });

  it('rejects loose directories and never follows a provider or value symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-secrets-links-'));
    roots.push(root);
    const loose = join(root, 'loose');
    await mkdir(loose, { mode: 0o755 });
    if (process.platform !== 'win32') await chmod(loose, 0o755);
    expect(() => new LocalFileSecretProvider(loose)).toThrowError(expect.objectContaining({ code: 'SECRET_DIRECTORY_MODE_INVALID' }));

    const targetDirectory = join(root, 'target-dir');
    await mkdir(targetDirectory, { mode: 0o700 });
    const linkedDirectory = join(root, 'linked-dir');
    await symlink(targetDirectory, linkedDirectory);
    expect(() => new LocalFileSecretProvider(linkedDirectory, { createDirectory: true })).toThrowError(expect.objectContaining({ code: 'SECRET_DIRECTORY_INVALID' }));

    const directory = join(root, 'secure');
    const provider = new LocalFileSecretProvider(directory, { createDirectory: true });
    const target = join(root, 'target-value');
    await writeFile(target, 'unchanged', { mode: 0o600 });
    await symlink(target, join(directory, 'linked.secret'));
    expect(provider.inspect('linked')).toEqual({ referenceKey: 'linked', availability: 'unreadable' });
    const value = bundle();
    expect(() => provider.writeExclusive('linked', value)).toThrowError(expect.objectContaining({ code: 'SECRET_ALREADY_EXISTS' }));
    expect(await readFile(target, 'utf8')).toBe('unchanged');
  });

  it('uses a fingerprint as the condition for replacement and removal', async () => {
    const { provider } = await fixture();
    const initial = provider.writeExclusive('conditional', bundle());
    const rejected = Buffer.from('new-value');
    expect(() => provider.replaceConditional('conditional', rejected, '0'.repeat(64))).toThrowError(expect.objectContaining({ code: 'SECRET_CONDITION_FAILED' }));
    expect(rejected.every(byte => byte === 0)).toBe(true);
    expect(provider.fingerprint('conditional')).toBe(initial.fingerprint);

    const next = Buffer.from(JSON.stringify({ schema_version: 1, kind: 'lark_app_credential', app_id: 'cli_fixture', app_secret: 'ROTATED_CANARY' }));
    const rotated = provider.replaceConditional('conditional', next, initial.fingerprint);
    expect(rotated.fingerprint).not.toBe(initial.fingerprint);
    expect(() => provider.removeConditional('conditional', initial.fingerprint)).toThrowError(expect.objectContaining({ code: 'SECRET_CONDITION_FAILED' }));
    provider.removeConditional('conditional', rotated.fingerprint);
    expect(provider.inspect('conditional').availability).toBe('missing');
  });

  it('releases a crashed owner, excludes aliases of the same key, and permits unrelated keys', async () => {
    const { root, directory, provider } = await fixture();
    const initial = provider.writeExclusive('crash', bundle());
    provider.writeExclusive('other', bundle());
    const marker = join(root, 'locked');
    const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', new URL('./lock-owner.test-helper.mjs', import.meta.url).pathname, directory, 'crash', initial.fingerprint, marker], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
    await vi.waitFor(() => { expect(child.exitCode, stderr).toBeNull(); expect(existsSync(marker), stderr).toBe(true); }, { timeout: 10_000 });
    await symlink(root, join(root, 'alias'));
    const alias = new LocalFileSecretProvider(join(root, 'alias/secrets'));
    const rejected = Buffer.from('blocked');
    expect(() => alias.replaceConditional('crash', rejected, initial.fingerprint)).toThrowError(expect.objectContaining({ code: 'SECRET_BUSY' }));
    expect(rejected.every(byte => byte === 0)).toBe(true);
    expect(() => alias.removeConditional('crash', initial.fingerprint)).toThrowError(expect.objectContaining({ code: 'SECRET_BUSY' }));
    alias.removeConditional('other');
    expect(provider.inspect('other').availability).toBe('missing');
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
    const recovered = new LocalFileSecretProvider(directory);
    const next = recovered.replaceConditional('crash', Buffer.from('after crash'), initial.fingerprint);
    expect(() => recovered.removeConditional('crash', initial.fingerprint)).toThrowError(expect.objectContaining({ code: 'SECRET_CONDITION_FAILED' }));
    recovered.removeConditional('crash', next.fingerprint);
    expect(recovered.inspect('crash').availability).toBe('missing');
    expect(existsSync(join(directory, '.crash.lock.sqlite'))).toBe(true);
    if (process.platform !== 'win32') expect((await lstat(join(directory, '.crash.lock.sqlite'))).mode & 0o777).toBe(0o600);
  });

  it('keeps the process lock after a same-process contender fails and excludes an independent writer', async () => {
    const { directory, provider } = await fixture();
    const initial = provider.writeExclusive('same-process', bundle());
    const other = new LocalFileSecretProvider(directory);
    const fingerprint = provider.fingerprint.bind(provider);
    vi.spyOn(provider, 'fingerprint').mockImplementationOnce(key => {
      expect(() => other.replaceConditional(key, Buffer.from('blocked'), initial.fingerprint)).toThrowError(expect.objectContaining({ code: 'SECRET_BUSY' }));
      const child = spawnSync(process.execPath, ['--conditions=development', '--import', 'tsx', new URL('./lock-contender.test-helper.mjs', import.meta.url).pathname, directory, key, initial.fingerprint], { encoding: 'utf8' });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ code: 'SECRET_BUSY' });
      return fingerprint(key);
    });
    provider.replaceConditional('same-process', Buffer.from('owner'), initial.fingerprint);
    expect(provider.fingerprint('same-process')).not.toBe(initial.fingerprint);
  });

  it('ignores but preserves legacy existence locks after a crash', async () => {
    const { directory, provider } = await fixture();
    const initial = provider.writeExclusive('legacy', bundle());
    const legacy = join(directory, '.legacy.lock');
    await writeFile(legacy, 'legacy lock', { mode: 0o600 });
    provider.replaceConditional('legacy', Buffer.from('new'), initial.fingerprint);
    expect(await readFile(legacy, 'utf8')).toBe('legacy lock');
  });

  it.each(['symlink', 'hardlink', 'loose'])('rejects a %s lock file before modifying its target or secret', async kind => {
    const { root, directory, provider } = await fixture();
    const initial = provider.writeExclusive('protected', bundle());
    const target = join(root, 'target');
    await writeFile(target, 'unchanged', { mode: kind === 'loose' ? 0o644 : 0o600 });
    const lock = join(directory, '.protected.lock.sqlite');
    if (kind === 'symlink') await symlink(target, lock);
    else if (kind === 'hardlink') await link(target, lock);
    else { await writeFile(lock, 'unchanged', { mode: 0o644 }); await chmod(lock, 0o644); }
    const value = Buffer.from('rejected');
    expect(() => provider.replaceConditional('protected', value, initial.fingerprint)).toThrow();
    expect(value.every(byte => byte === 0)).toBe(true);
    expect(provider.fingerprint('protected')).toBe(initial.fingerprint);
    expect(await readFile(target, 'utf8')).toBe('unchanged');
  });

  it('requires an explicit listener boundary and wipes the callback credential object afterward', async () => {
    const { provider } = await fixture();
    provider.writeExclusive('runtime', bundle());
    expect(() => new LocalFileLarkCredentialResolver(provider, {} as LarkListenerSecretBoundary)).toThrowError(expect.objectContaining({ code: 'SECRET_RUNTIME_BOUNDARY_REQUIRED' }));
    const resolver = new LocalFileLarkCredentialResolver(provider, LarkListenerSecretBoundary.create());
    let captured: { app_id: string; app_secret: string } | undefined;
    const appId = await resolver.withCredentials('runtime', credentials => {
      captured = credentials;
      return credentials.app_id;
    });
    expect(appId).toBe('cli_fixture');
    expect(captured).toEqual(expect.objectContaining({ app_id: '', app_secret: '' }));
  });

  it('accepts only an authentic purpose-fixed identity-preflight boundary', async () => {
    const { provider } = await fixture();
    provider.writeExclusive('preflight', bundle());
    const forged = { purpose: 'identity_preflight', _isAuthentic: () => true } as unknown as LarkIdentityPreflightSecretBoundary;
    expect(() => new LocalFileLarkCredentialResolver(provider, forged)).toThrowError(expect.objectContaining({ code: 'SECRET_RUNTIME_BOUNDARY_REQUIRED' }));

    const boundary = LarkIdentityPreflightSecretBoundary.create();
    expect(boundary.purpose).toBe('identity_preflight');
    const resolver = new LocalFileLarkCredentialResolver(provider, boundary);
    let captured: { app_id: string; app_secret: string } | undefined;
    const result = await resolver.withCredentials('preflight', (credentials, metadata) => {
      captured = credentials;
      return { appId: credentials.app_id, fingerprint: metadata.fingerprint };
    });
    expect(result).toEqual({ appId: 'cli_fixture', fingerprint: provider.fingerprint('preflight') });
    expect(captured).toEqual(expect.objectContaining({ app_id: '', app_secret: '' }));
  });

  it('derives the provider beside the persisted database only', () => {
    expect(secretDirectoryForDatabase('/srv/dutydeck/dutydeck.db')).toBe('/srv/dutydeck/secrets');
    expect(() => secretDirectoryForDatabase(':memory:')).toThrowError(SecretProviderError);
  });
});
