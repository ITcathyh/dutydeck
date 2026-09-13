import { describe, expect, it, vi } from 'vitest';
import {
  OpenPlatformConfigurationJobManager,
  type OpenPlatformConfigurationResult,
} from './open-platform-jobs.js';
import type {
  ConnectOpenPlatformSessionOptions,
  ConnectedOpenPlatformSession,
} from './open-platform-session.js';

const result: OpenPlatformConfigurationResult = {
  status: 'ready',
  scopeCount: 16,
  eventCount: 1,
  callbackCount: 1,
  versionId: 'version-public-id',
};

const client = { apiOrigin: 'https://open.feishu.cn', postJson: vi.fn(async () => ({ code: 0 })), postForm: vi.fn(async () => ({ code: 0 })) };
const connected = (): ConnectedOpenPlatformSession => ({
  source: 'qr_login',
  client,
  owner: {
    userId: 'private-user-id',
    userName: 'Alice',
    tenantId: 'private-tenant-id',
    tenantName: 'Acme',
  },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('OpenPlatformConfigurationJobManager', () => {
  it('moves through QR/configuration states and only exposes display names', async () => {
    const release = deferred<void>();
    const rawQrPayload = '{"qrlogin":{"token":"private-login-token"}}';
    const connect = vi.fn(async (options: ConnectOpenPlatformSessionOptions) => {
      await options.onQrUpdate?.({ qrPayload: rawQrPayload, status: 'waiting_for_scan' });
      await options.onQrUpdate?.({ qrPayload: rawQrPayload, status: 'scan_confirmed' });
      await release.promise;
      return connected();
    });
    const configure = vi.fn(async () => result);
    const manager = new OpenPlatformConfigurationJobManager({
      connect,
      configure,
      qrDataUrl: vi.fn(async () => 'data:image/png;base64,opaque-qr'),
    });

    const started = manager.start('cli_test');
    expect(started.status).toBe('preparing');
    await vi.waitFor(() => expect(manager.get(started.id)?.status).toBe('waiting_for_scan'));
    const waiting = manager.get(started.id)!;
    expect(waiting.qrDataUrl).toBe('data:image/png;base64,opaque-qr');
    expect(waiting.scanConfirmed).toBe(true);
    expect(JSON.stringify(waiting)).not.toContain('private-login-token');

    release.resolve();
    const completed = await manager.wait(started.id);
    expect(completed).toMatchObject({
      status: 'completed',
      accountName: 'Alice',
      tenantName: 'Acme',
      result,
    });
    expect(completed).not.toHaveProperty('qrDataUrl');
    const serialized = JSON.stringify(completed);
    expect(serialized).not.toContain('private-user-id');
    expect(serialized).not.toContain('private-tenant-id');
    expect(serialized).not.toContain('alice@example.com');
    expect(configure).toHaveBeenCalledOnce();
  });

  it('reuses the same active app job so publish is not duplicated', async () => {
    const release = deferred<void>();
    const connect = vi.fn(async () => {
      await release.promise;
      return connected();
    });
    const configure = vi.fn(async () => result);
    const manager = new OpenPlatformConfigurationJobManager({ connect, configure });

    const first = manager.start('cli_same_app');
    const second = manager.start(' cli_same_app ', { forceLogin: true });
    expect(second.id).toBe(first.id);
    expect(connect).toHaveBeenCalledOnce();

    release.resolve();
    await manager.wait(first.id);
    expect(configure).toHaveBeenCalledOnce();
  });

  it('allows only one active app configuration to protect the shared session cache', async () => {
    const release = deferred<void>();
    const manager = new OpenPlatformConfigurationJobManager({
      connect: vi.fn(async () => { await release.promise; return connected(); }),
      configure: vi.fn(async () => result),
    });

    const first = manager.start('cli_first');
    expect(() => manager.start('cli_second')).toThrow('仍在进行');
    release.resolve();
    await manager.wait(first.id);
    expect(manager.start('cli_second').appId).toBe('cli_second');
  });

  it('retains only the configured number of terminal jobs', async () => {
    const manager = new OpenPlatformConfigurationJobManager({
      connect: vi.fn(async () => connected()),
      configure: vi.fn(async () => result),
      retainedJobLimit: 2,
    });
    const first = manager.start('cli_first'); await manager.wait(first.id);
    const second = manager.start('cli_second'); await manager.wait(second.id);
    const third = manager.start('cli_third'); await manager.wait(third.id);

    expect(manager.get(first.id)).toBeUndefined();
    expect(manager.get(second.id)?.status).toBe('completed');
    expect(manager.get(third.id)?.status).toBe('completed');
  });

  it('fails closed when an injected session cannot prove owner identity', async () => {
    const invalid = connected();
    invalid.owner = { userId: '', userName: 'Alice', tenantId: '', tenantName: 'Acme' };
    const configure = vi.fn(async () => result);
    const manager = new OpenPlatformConfigurationJobManager({
      connect: vi.fn(async () => invalid),
      configure,
    });

    const started = manager.start('cli_unknown_owner');
    const failed = await manager.wait(started.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('为避免配置到错误企业');
    expect(configure).not.toHaveBeenCalled();
  });

  it('redacts credential-bearing failures from public job state', async () => {
    const secret = 'secret-value-abcdefghijklmnopqrstuvwxyz';
    const csrf = 'csrf-value-abcdefghijklmnopqrstuvwxyz';
    const cookie = 'cookie-value-abcdefghijklmnopqrstuvwxyz';
    const manager = new OpenPlatformConfigurationJobManager({
      connect: vi.fn(async () => {
        throw new Error(`app_secret=${secret} csrf_token=${csrf} cookie=${cookie}`);
      }),
    });

    const started = manager.start('cli_failure');
    const failed = await manager.wait(started.id);
    expect(failed?.status).toBe('failed');
    const serialized = JSON.stringify(failed);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(csrf);
    expect(serialized).not.toContain(cookie);
  });
});
