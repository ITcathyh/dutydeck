import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '@dutydeck/shared';
import { LarkAppCreationJobManager } from './app-creation.js';
import { LarkOpenPlatformConfigurationError } from './open-platform-configurator.js';
import { OpenPlatformRequestError, OpenPlatformSessionError, type ConnectedOpenPlatformSession, type ConnectOpenPlatformSessionOptions } from './open-platform-session.js';
import { readLarkConfig, saveLarkConfig } from './config.js';

const id = 'dfe543ed-a565-46af-8f04-552fd038df58';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  const records = new Map<string, string>();
  const config: ConfigRepository = {
    get: vi.fn(async key => records.get(key)),
    set: vi.fn(async (key, value) => { records.set(key, value); }),
    compareAndSet: vi.fn(async (key, expected, value) => { if (records.get(key) !== expected) return false; records.set(key, value); return true; }),
  };
  const postJson = vi.fn(async (path: string, _body?: unknown): Promise<unknown> => {
    if (path.includes('upsert_by_template')) return { data: { ClientID: 'cli_created' } };
    if (path.includes('/secret/')) {
      expect(JSON.parse(records.get(`lark.app_creation.${id}`)!)).toMatchObject({ appId: 'cli_created' });
      return { data: { secret: 'test-private-secret' } };
    }
    throw new Error('unexpected endpoint');
  });
  const postForm = vi.fn(async (_path: string, _body: FormData): Promise<unknown> => ({ data: { url: 'https://example.invalid/icon.png' } }));
  const connected: ConnectedOpenPlatformSession = { source: 'qr_login', client: { apiOrigin: 'https://open.feishu.cn', postJson, postForm }, owner: { userId: 'private-user', userName: 'Alice', tenantId: 'private-tenant', tenantName: 'Acme' } };
  const connect = vi.fn(async (options: ConnectOpenPlatformSessionOptions = {}) => {
    await options.onQrUpdate?.({ status: 'waiting_for_scan', qrPayload: 'private-qr-token' });
    return connected;
  });
  const configure = vi.fn(async (): Promise<{ status: 'ready'; scopeCount: number; skippedScopes: string[]; eventCount: number; callbackCount: number; versionId: string }> =>
    ({ status: 'ready', scopeCount: 16, skippedScopes: [], eventCount: 1, callbackCount: 1, versionId: 'v1' }));
  const syncSlashCommands = vi.fn(async (_input: { appId: string; appSecret: string }) => ({ created: [], updated: [] }));
  const options = { config, connect, configure, syncSlashCommands, qrDataUrl: vi.fn(async () => 'data:image/png;base64,private-qr') };
  const manager = new LarkAppCreationJobManager(options);
  return { records, config, connected, connect, configure, syncSlashCommands, postJson, postForm, options, manager };
}

it('creates once, durably saves credentials privately and configures creator visibility', async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.manager.start(id, 'My Bot'), h.manager.start(id, 'My Bot')]);
  expect(first.id).toBe(id);
  expect(second.id).toBe(id);
  await h.manager.wait(id);
  const job = await h.manager.get(id);
  expect(job).toMatchObject({ status: 'completed', botSaved: true, appId: 'cli_created', accountName: 'Alice', tenantName: 'Acme' });
  expect(h.connect).toHaveBeenCalledOnce();
  expect(h.connect.mock.calls[0]![0]).toMatchObject({ forceLogin: true });
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('upsert_by_template'))).toHaveLength(1);
  expect(h.postJson.mock.calls[0]![1]).toMatchObject({ cid: id, appManifestTemplateID: 'developer_console' });
  expect(h.postForm.mock.calls[0]![1].get('uploadType')).toBe('4');
  expect(h.configure).toHaveBeenCalledWith(h.connected.client, 'cli_created', { creatorUserId: 'private-user' });
  expect(await readLarkConfig(h.config, 'cli_created')).toMatchObject({ name: 'My Bot', appSecret: 'test-private-secret', listening: false });
  for (const value of [JSON.stringify(job), h.records.get(`lark.app_creation.${id}`)!]) {
    for (const secret of ['test-private-secret', 'private-user', 'private-tenant', 'private-qr']) expect(value).not.toContain(secret);
  }
  const restarted = new LarkAppCreationJobManager(h.options);
  expect(await restarted.start(id, 'Ignored duplicate name')).toMatchObject({ status: 'completed', name: 'My Bot' });
  expect(h.connect).toHaveBeenCalledOnce();
});

it('distinguishes a confirmed scan followed by a session failure from icon upload failure', async () => {
  const login = harness();
  login.connect.mockImplementation(async options => {
    await options?.onQrUpdate?.({ qrPayload: 'qr', status: 'scan_confirmed' });
    throw new OpenPlatformSessionError('console', new Error('private-credential-canary'));
  });
  await login.manager.start(id, 'Bot'); await login.manager.wait(id);
  expect(await login.manager.get(id)).toMatchObject({ status: 'failed', scanConfirmed: true, retryable: true, error: expect.stringContaining('扫码后无法建立飞书开放平台会话') });
  expect(JSON.stringify(await login.manager.get(id))).not.toContain('private-credential-canary');
  expect(login.postForm).not.toHaveBeenCalled();

  const icon = harness();
  icon.postForm.mockRejectedValueOnce(new Error('private-credential-canary'));
  await icon.manager.start(id, 'Bot'); await icon.manager.wait(id);
  expect(await icon.manager.get(id)).toMatchObject({ status: 'failed', retryable: true, error: expect.stringContaining('登录已完成，但机器人图标上传失败') });
  expect(icon.postJson).not.toHaveBeenCalled();
});

it.each(['login', 'qr', 'upload'] as const)('cancels during %s without creating after an awaited callback returns', async stage => {
  const h = harness();
  const gate = deferred<void>();
  if (stage === 'login') h.connect.mockImplementation(async () => { await gate.promise; return h.connected; });
  if (stage === 'qr') h.options.qrDataUrl.mockImplementation(async () => { await gate.promise; return 'data:image/png;base64,late'; });
  if (stage === 'upload') h.postForm.mockImplementation(async () => { await gate.promise; return { data: { url: 'icon' } }; });
  await h.manager.start(id, 'Bot');
  await vi.waitFor(() => expect(stage === 'upload' ? h.postForm : stage === 'qr' ? h.options.qrDataUrl : h.connect).toHaveBeenCalled());
  expect(await h.manager.cancel(id)).toMatchObject({ status: 'cancelled' });
  gate.resolve();
  await h.manager.wait(id);
  expect(h.postJson).not.toHaveBeenCalled();
  expect(await h.manager.get(id)).toMatchObject({ status: 'cancelled' });
  expect(await h.manager.get(id)).not.toHaveProperty('qrDataUrl');
});

it('refuses cancellation once template creation starts', async () => {
  const h = harness(); const gate = deferred<unknown>();
  h.postJson.mockImplementationOnce(() => gate.promise);
  await h.manager.start(id, 'Bot');
  await vi.waitFor(() => expect(h.postJson).toHaveBeenCalledOnce());
  await expect(h.manager.cancel(id)).rejects.toMatchObject({ statusCode: 409 });
  gate.resolve({ data: { ClientID: 'cli_created' } });
  await h.manager.wait(id);
});

it.each([
  ['network', new Error('secret=private-upstream-value'), false],
  ['server', new OpenPlatformRequestError('private-upstream-value', 503), false],
  ['timeout', new OpenPlatformRequestError('timeout', 408), false],
  ['business', new OpenPlatformRequestError('rejected', 200, 17), true],
  ['not found', new OpenPlatformRequestError('rejected', 404), true],
] as const)('treats %s creation failure conservatively', async (_label, failure, retryable) => {
  const h = harness(); h.postJson.mockRejectedValueOnce(failure);
  await h.manager.start(id, 'Bot'); await h.manager.wait(id);
  expect(await h.manager.get(id)).toMatchObject({ status: 'failed', retryable });
  expect(JSON.stringify(await h.manager.get(id))).not.toContain('private-upstream-value');
  if (!retryable) await expect(h.manager.retry(id)).rejects.toMatchObject({ statusCode: 409 });
});

it('does not recreate after a successful response without an app ID', async () => {
  const h = harness(); h.postJson.mockResolvedValueOnce({ code: 0, data: {} });
  await h.manager.start(id, 'Bot'); await h.manager.wait(id);
  expect(await h.manager.get(id)).toMatchObject({ status: 'failed', retryable: false });
  await h.manager.start(id, 'Bot');
  expect(h.connect).toHaveBeenCalledOnce();
});

it('retries secret retrieval after restart using the same app and original owner', async () => {
  const h = harness(); h.postJson.mockImplementationOnce(async () => ({ data: { appId: 'cli_created' } })).mockRejectedValueOnce(new Error('secret read failed'));
  await h.manager.start(id, 'Bot'); await h.manager.wait(id);
  expect(await h.manager.get(id)).toMatchObject({ status: 'failed', appId: 'cli_created', retryable: true });
  const restarted = new LarkAppCreationJobManager(h.options);
  await restarted.retry(id); await restarted.wait(id);
  expect(await restarted.get(id)).toMatchObject({ status: 'completed', botSaved: true });
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('upsert_by_template'))).toHaveLength(1);
});

it('refuses a different scanned owner on retry', async () => {
  const h = harness(); h.postJson.mockImplementationOnce(async () => ({ data: { appId: 'cli_created' } })).mockRejectedValueOnce(new Error());
  await h.manager.start(id, 'Bot'); await h.manager.wait(id);
  h.connected.owner.userId = 'another-owner';
  await h.manager.retry(id); await h.manager.wait(id);
  expect(await h.manager.get(id)).toMatchObject({ status: 'failed', retryable: true });
  expect(h.configure).not.toHaveBeenCalled();
  expect(h.postJson).toHaveBeenCalledTimes(2);
});

it('preserves an already-saved app and never replays uncertain configuration', async () => {
  const h = harness();
  await saveLarkConfig(h.config, undefined, { stage: 'lark', appId: 'cli_created', appSecret: 'user-edited-secret', name: 'Edited Bot', listening: false });
  h.configure.mockRejectedValueOnce(new Error('private publish error'));
  await h.manager.start(id, 'Bot'); await h.manager.wait(id);
  expect(await h.manager.get(id)).toMatchObject({ status: 'failed', botSaved: true, retryable: false });
  expect(await readLarkConfig(h.config, 'cli_created')).toMatchObject({ name: 'Edited Bot', appSecret: 'user-edited-secret' });
  expect(h.postJson.mock.calls.some(([path]) => path.includes('/secret/'))).toBe(false);
  await expect(h.manager.retry(id)).rejects.toMatchObject({ statusCode: 409 });
});

it('reports a permission failure and resumes configuration of the same saved app', async () => {
  const h = harness();
  h.configure.mockRejectedValueOnce(new LarkOpenPlatformConfigurationError('scope_verification_failed', '必需应用权限未加入待发布草稿'));
  await h.manager.start(id, 'Bot'); await h.manager.wait(id);
  expect(await h.manager.get(id)).toMatchObject({
    status: 'failed', botSaved: true, retryable: true,
    error: expect.stringContaining('必需应用权限未加入待发布草稿（scope_verification_failed）'),
  });
  const restarted = new LarkAppCreationJobManager(h.options);
  await restarted.retry(id); await restarted.wait(id);
  expect(await restarted.get(id)).toMatchObject({ status: 'completed', appId: 'cli_created' });
  expect(h.configure).toHaveBeenCalledTimes(2);
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('upsert_by_template'))).toHaveLength(1);
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('/secret/'))).toHaveLength(1);
});

it('preserves a submitted review as a distinct terminal state without replaying publication', async () => {
  const h = harness();
  h.configure.mockRejectedValueOnce(new LarkOpenPlatformConfigurationError('publish_pending_review', '应用版本已提交，正在等待飞书管理员审核'));
  await h.manager.start(id, 'Bot'); await h.manager.wait(id);
  const restarted = new LarkAppCreationJobManager(h.options);
  expect(await restarted.get(id)).toMatchObject({ status: 'pending_review', appId: 'cli_created', botSaved: true, retryable: false });
  expect(await restarted.get(id)).not.toHaveProperty('error');
  await expect(restarted.retry(id)).rejects.toMatchObject({ statusCode: 409 });
  expect(h.configure).toHaveBeenCalledOnce();
});

it.each(['version_create_failed', 'version_verification_failed', 'publish_failed', 'publish_verification_failed', 'unknown_future_failure'])(
  'never replays an uncertain configuration failure: %s', async code => {
    const h = harness();
    h.configure.mockRejectedValueOnce(new LarkOpenPlatformConfigurationError(code, '配置未完成'));
    await h.manager.start(id, 'Bot'); await h.manager.wait(id);
    expect(await h.manager.get(id)).toMatchObject({ status: 'failed', botSaved: true, retryable: false });
    await expect(h.manager.retry(id)).rejects.toMatchObject({ statusCode: 409 });
  },
);

it.each(['creating', 'configuring'] as const)('recovers interrupted %s fail-closed without external writes', async status => {
  const h = harness();
  h.records.set(`lark.app_creation.${id}`, JSON.stringify({ id, name: 'Bot', status, retryable: false, appId: 'cli_created', createdAt: 'now', updatedAt: 'now' }));
  expect(await h.manager.get(id)).toMatchObject({ status: 'failed', retryable: false });
  await expect(h.manager.retry(id)).rejects.toMatchObject({ statusCode: 409 });
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.postJson).not.toHaveBeenCalled();
});

it('retries a failed local save without creating another app', async () => {
  const h = harness();
  const save = vi.fn(saveLarkConfig).mockRejectedValueOnce(new Error('disk unavailable'));
  const manager = new LarkAppCreationJobManager({ ...h.options, save });
  await manager.start(id, 'Bot'); await manager.wait(id);
  expect(await manager.get(id)).toMatchObject({ status: 'failed', retryable: true, appId: 'cli_created' });
  expect(await manager.get(id)).not.toHaveProperty('botSaved');
  await manager.retry(id); await manager.wait(id);
  expect(await manager.get(id)).toMatchObject({ status: 'completed', botSaved: true });
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('upsert_by_template'))).toHaveLength(1);
});

it('recovers a pre-creation restart with a fresh QR, while GET remains read-only remotely', async () => {
  const h = harness();
  h.records.set(`lark.app_creation.${id}`, JSON.stringify({ id, name: 'Bot', status: 'waiting_for_scan', retryable: false, createdAt: 'now', updatedAt: 'now' }));
  expect(await h.manager.get(id)).toMatchObject({ status: 'failed', retryable: true });
  expect(h.connect).not.toHaveBeenCalled();
  await h.manager.retry(id); await h.manager.wait(id);
  expect(await h.manager.get(id)).toMatchObject({ status: 'completed' });
});

it('shares one active request across managers in the same process and refreshes foreign terminal state', async () => {
  const h = harness();
  const gate = deferred<void>();
  h.connect.mockImplementation(async options => {
    await options?.onQrUpdate?.({ status: 'waiting_for_scan', qrPayload: 'private-qr' });
    await gate.promise;
    return h.connected;
  });
  const other = new LarkAppCreationJobManager(h.options);
  const results = await Promise.all([h.manager.start(id, 'Bot'), other.start(id, 'Bot')]);
  expect(results.map(job => job.id)).toEqual([id, id]);
  await vi.waitFor(async () => expect(await other.get(id)).toMatchObject({ status: 'waiting_for_scan', retryable: false }));
  await expect(other.retry(id)).rejects.toMatchObject({ statusCode: 409 });
  await expect(h.manager.retry(id)).rejects.toMatchObject({ statusCode: 409 });
  expect(h.connect).toHaveBeenCalledOnce();
  expect(JSON.stringify(await other.get(id))).not.toContain('runner');
  gate.resolve();
  await Promise.all([h.manager.wait(id), other.wait(id)]);
  expect(await other.get(id)).toMatchObject({ status: 'completed', botSaved: true });
  expect(await h.manager.get(id)).toMatchObject({ status: 'completed', botSaved: true });
  expect(h.postJson.mock.calls.filter(([path]) => path.includes('upsert_by_template'))).toHaveLength(1);
});

it('recognizes a live foreign process, then CAS-claims one safe retry after that process exits', async () => {
  const h = harness();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    h.records.set(`lark.app_creation.${id}`, JSON.stringify({
      id, name: 'Bot', status: 'waiting_for_scan', retryable: false, createdAt: 'now', updatedAt: 'now',
      runner: { pid: child.pid, instanceId: 'foreign-manager' },
    }));
    const other = new LarkAppCreationJobManager(h.options);
    expect(await h.manager.get(id)).toMatchObject({ status: 'waiting_for_scan', retryable: false });
    expect(await other.start(id, 'Bot')).toMatchObject({ status: 'waiting_for_scan' });
    await expect(h.manager.retry(id)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.connect).not.toHaveBeenCalled();
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    const recovered = await Promise.all([h.manager.get(id), other.get(id)]);
    for (const job of recovered) expect(job).toMatchObject({ status: 'failed', retryable: true });
    const gate = deferred<void>();
    h.connect.mockImplementation(async () => { await gate.promise; return h.connected; });
    const claims = await Promise.allSettled([h.manager.retry(id), other.retry(id)]);
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(h.connect).toHaveBeenCalledOnce();
    gate.resolve();
    await Promise.all([h.manager.wait(id), other.wait(id)]);
    expect(h.postJson.mock.calls.filter(([path]) => path.includes('upsert_by_template'))).toHaveLength(1);
    expect(await h.manager.get(id)).toMatchObject({ status: 'completed' });
    expect(await other.get(id)).toMatchObject({ status: 'completed' });
  } finally {
    child.kill();
  }
});

it('honors cancellation from another instance before the original run creates an app', async () => {
  const h = harness(); const gate = deferred<void>();
  h.postForm.mockImplementation(async () => { await gate.promise; return { data: { url: 'icon' } }; });
  await h.manager.start(id, 'Bot');
  await vi.waitFor(() => expect(h.postForm).toHaveBeenCalledOnce());
  const other = new LarkAppCreationJobManager(h.options);
  expect(await other.cancel(id)).toMatchObject({ status: 'cancelled' });
  gate.resolve(); await h.manager.wait(id);
  expect(await h.manager.get(id)).toMatchObject({ status: 'cancelled' });
  expect(h.postJson).not.toHaveBeenCalled();
});

it('refuses a repository without atomic compare-and-set before login or external writes', async () => {
  const h = harness();
  const manager = new LarkAppCreationJobManager({ ...h.options, config: { get: h.config.get, set: h.config.set } });
  await expect(manager.start(id, 'Bot')).rejects.toMatchObject({ statusCode: 503 });
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.records.size).toBe(0);
});

describe('首配后的原生斜杠命令同步', () => {
  it('发布确认通过后用新应用自己的凭据同步一次，新建的机器人立刻就有命令菜单', async () => {
    const h = harness();
    await h.manager.start(id, 'My Bot');
    await h.manager.wait(id);
    expect(await h.manager.get(id)).toMatchObject({ status: 'completed' });
    // 权限要等版本确认发布之后才对 tenant token 生效，所以必须排在 configure 之后。
    expect(h.syncSlashCommands).toHaveBeenCalledExactlyOnceWith({ appId: 'cli_created', appSecret: 'test-private-secret' });
    expect(h.syncSlashCommands.mock.invocationCallOrder[0]!).toBeGreaterThan(h.configure.mock.invocationCallOrder[0]!);
  });

  it('企业权限目录缺少斜杠命令权限时不发这个注定 403 的请求', async () => {
    const h = harness();
    h.configure.mockResolvedValueOnce({ status: 'ready', scopeCount: 15, skippedScopes: ['application:app_slash_command:write'], eventCount: 1, callbackCount: 1, versionId: 'v1' });
    await h.manager.start(id, 'My Bot');
    await h.manager.wait(id);
    expect(await h.manager.get(id)).toMatchObject({ status: 'completed' });
    expect(h.syncSlashCommands).not.toHaveBeenCalled();
  });

  it('同步失败不改变建应用的结论：应用仍然是已完成，只是暂时没有命令菜单', async () => {
    const h = harness();
    h.syncSlashCommands.mockRejectedValueOnce(new Error('private upstream failure'));
    await h.manager.start(id, 'My Bot');
    await h.manager.wait(id);
    const job = await h.manager.get(id);
    expect(job).toMatchObject({ status: 'completed', retryable: false });
    expect(job!.error).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain('private upstream failure');
  });

  it('审核中时不同步：版本没生效，写命令必然 403', async () => {
    const h = harness();
    h.configure.mockRejectedValueOnce(new LarkOpenPlatformConfigurationError('publish_pending_review', '应用版本已提交，正在等待飞书管理员审核'));
    await h.manager.start(id, 'My Bot');
    await h.manager.wait(id);
    expect(await h.manager.get(id)).toMatchObject({ status: 'pending_review' });
    expect(h.syncSlashCommands).not.toHaveBeenCalled();
  });
});
