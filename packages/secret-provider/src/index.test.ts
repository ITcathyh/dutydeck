import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LarkIdentityPreflightSecretBoundary,
  LarkListenerSecretBoundary,
  LocalFileLarkCredentialResolver,
  LocalFileSecretProvider,
  SecretProviderError,
  secretDirectoryForDatabase
} from './index.js';

const roots: string[] = [];
const bundle = () => Buffer.from(JSON.stringify({ schema_version: 1, kind: 'lark_app_credential', app_id: 'cli_fixture', app_secret: 'SECRET_CANARY' }));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dockmux-secrets-'));
  roots.push(root);
  const directory = join(root, 'secrets');
  return { root, directory, provider: new LocalFileSecretProvider(directory, { createDirectory: true }) };
}

afterEach(async () => {
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
    const root = await mkdtemp(join(tmpdir(), 'dockmux-secrets-links-'));
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
    expect(secretDirectoryForDatabase('/srv/dockmux/dockmux.db')).toBe('/srv/dockmux/secrets');
    expect(() => secretDirectoryForDatabase(':memory:')).toThrowError(SecretProviderError);
  });
});
