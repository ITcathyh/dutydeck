import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFileSecretProvider } from '@dutydeck/secret-provider';
import type { ChannelBotFoundation, GroupBinding, SecretRefMetadata } from '@dutydeck/shared';
import { IdentityPreflightError, LarkIdentityPreflightProbe } from './identity-preflight.js';

const roots: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
const checkedAt = new Date('2026-08-30T08:00:00.000Z');
const secretCanary = 'SECRET_CANARY_DO_NOT_LEAK';
const piiCanaries = ['cli_remote_private', 'ou_private_open_id', 'tenant_private_key', 'Private Bot Name', 'Private Chat Name', 'alice@example.com'];

const channelBot = (credentialRef = 'secret-ref-1'): ChannelBotFoundation => ({
  schemaVersion: 1,
  id: 'channel-bot-1',
  revision: 7,
  channel: 'lark',
  externalAppId: 'cli_expected_app',
  displayName: 'Managed bot',
  brand: 'feishu',
  credentialRef,
  state: 'staged',
  desiredListenerState: 'disabled',
  fullTrustConfirmed: false,
  createdAt: checkedAt.toISOString(),
  updatedAt: checkedAt.toISOString(),
});

const groupBinding = (id = 'binding-1', externalChatId = 'oc_private_chat'): GroupBinding => ({
  schemaVersion: 1,
  id,
  revision: 3,
  channelBotId: 'channel-bot-1',
  externalChatId,
  state: 'staged',
  oncall: true,
  agentOverride: { mode: 'inherit' },
  workspaceOverride: { mode: 'inherit' },
  modelOverride: { mode: 'inherit' },
  reasoningOverride: { mode: 'inherit' },
  rolePolicyOverride: { mode: 'inherit' },
  routingOverride: { groupReplyMode: { mode: 'inherit' }, mentionPolicy: { mode: 'inherit' } },
  accessOverride: { mode: 'inherit', principalIds: [] },
  groupToolsOverride: { read: 'inherit', discover: 'inherit', send: 'inherit' },
  presentationOverride: { mode: 'inherit' },
  reviewReasons: [],
  createdAt: checkedAt.toISOString(),
  updatedAt: checkedAt.toISOString(),
});

const secretRef = (): SecretRefMetadata => ({
  schemaVersion: 1,
  id: 'secret-ref-1',
  revision: 2,
  kind: 'lark_app_secret',
  provider: 'local-file-v1',
  referenceKey: 'lark.preflight.fixture',
  status: 'configured',
  createdAt: checkedAt.toISOString(),
  updatedAt: checkedAt.toISOString(),
});

async function secretFixture(appId = 'cli_expected_app') {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-identity-preflight-'));
  roots.push(root);
  const provider = new LocalFileSecretProvider(join(root, 'secrets'), { createDirectory: true });
  provider.writeExclusive(secretRef().referenceKey, Buffer.from(JSON.stringify({
    schema_version: 1,
    kind: 'lark_app_credential',
    app_id: appId,
    app_secret: secretCanary,
  })));
  return { root, provider };
}

interface FakeLarkOptions {
  tokenStatus?: number;
  tokenBody?: unknown;
  applicationStatus?: number;
  applicationBody?: unknown;
  membershipStatus?: number;
  membershipBody?: unknown;
  chatStatus?: number;
  chatBody?: unknown;
}

async function fakeLarkServer(options: FakeLarkOptions = {}) {
  const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.url === '/open-apis/auth/v3/tenant_access_token/internal/') {
      return send(options.tokenStatus ?? 200, options.tokenBody ?? { code: 0, tenant_access_token: 'TOKEN_CANARY_DO_NOT_LEAK', expire: 7200 });
    }
    if (request.url?.startsWith('/open-apis/application/v6/applications/')) {
      return send(options.applicationStatus ?? 200, options.applicationBody ?? { code: 0, data: { app: { app_id: 'cli_expected_app', tenant_key: 'tenant_private_key' } } });
    }
    if (request.url === '/open-apis/bot/v3/info') {
      return send(200, { code: 0, bot: { app_name: 'Private Bot Name', open_id: 'ou_private_open_id', avatar_url: 'https://private.invalid/avatar' } });
    }
    if (request.url?.endsWith('/members/is_in_chat')) {
      return send(options.membershipStatus ?? 200, options.membershipBody ?? { code: 0, data: { is_in_chat: true } });
    }
    if (request.url?.startsWith('/open-apis/im/v1/chats/')) {
      return send(options.chatStatus ?? 200, options.chatBody ?? { code: 0, data: { name: 'Private Chat Name', chat_mode: 'topic_group', chat_status: 'normal' } });
    }
    return send(404, { code: 404, msg: 'unexpected fake route' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake Lark server did not bind');
  const close = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
  servers.push({ close });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Lark App×Chat identity preflight', () => {
  it('uses only read-only identity/chat APIs and emits an exact non-sensitive allowlist', async () => {
    const { provider } = await secretFixture();
    const fake = await fakeLarkServer();
    const probe = new LarkIdentityPreflightProbe({
      secretProvider: provider,
      baseUrlForBrand: () => fake.baseUrl,
      now: () => checkedAt,
    });

    const result = await probe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [groupBinding()] });

    expect(result).toEqual({
      schemaVersion: 1,
      channelBotId: 'channel-bot-1',
      credentialFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      appFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      botIdentityOpaqueRef: expect.stringMatching(/^remote_bot_[a-f0-9]{24}$/),
      tenantOpaqueRef: expect.stringMatching(/^remote_tenant_[a-f0-9]{24}$/),
      appMatch: true,
      tenantAppMatch: true,
      checkedAt: '2026-08-30T08:00:00.000Z',
      expiresAt: '2026-08-30T12:00:00.000Z',
      status: 'passed',
      chatFacts: [{ groupBindingId: 'binding-1', chatAccessible: true, membershipState: 'member', chatType: 'topic_group' }],
      blockerCodes: [],
      activationChanged: false,
      listenerReadiness: 'blocked',
    });
    expect(fake.requests.map(request => `${request.method} ${request.url}`)).toEqual([
      'POST /open-apis/auth/v3/tenant_access_token/internal/',
      'GET /open-apis/bot/v3/info',
      'GET /open-apis/application/v6/applications/cli_expected_app?lang=en_us',
      'GET /open-apis/im/v1/chats/oc_private_chat/members/is_in_chat',
      'GET /open-apis/im/v1/chats/oc_private_chat?user_id_type=open_id',
    ]);
    const serialized = JSON.stringify(result);
    for (const canary of [secretCanary, 'TOKEN_CANARY_DO_NOT_LEAK', ...piiCanaries, 'oc_private_chat']) expect(serialized).not.toContain(canary);
    expect(channelBot().state).toBe('staged');
    expect(channelBot().desiredListenerState).toBe('disabled');
  });

  it('fails before network on a missing, unreadable, or App-mismatched selected secret', async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), 'dutydeck-identity-preflight-missing-'));
    roots.push(missingRoot);
    const missingProvider = new LocalFileSecretProvider(join(missingRoot, 'secrets'), { createDirectory: true });
    const noNetwork = () => { throw new Error('network must not be called'); };
    const missingProbe = new LarkIdentityPreflightProbe({ secretProvider: missingProvider, clientFactory: noNetwork });
    await expect(missingProbe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [] }))
      .rejects.toMatchObject({ code: 'IDENTITY_PREFLIGHT_SECRET_MISSING' });

    const unreadable = await secretFixture();
    if (process.platform !== 'win32') await chmod(join(unreadable.root, 'secrets', `${secretRef().referenceKey}.secret`), 0o644);
    const unreadableProbe = new LarkIdentityPreflightProbe({ secretProvider: unreadable.provider, clientFactory: noNetwork });
    await expect(unreadableProbe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [] }))
      .rejects.toMatchObject({ code: 'IDENTITY_PREFLIGHT_SECRET_UNREADABLE' });

    const mismatch = await secretFixture('cli_other_app');
    const mismatchProbe = new LarkIdentityPreflightProbe({ secretProvider: mismatch.provider, clientFactory: noNetwork });
    await expect(mismatchProbe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [] }))
      .rejects.toMatchObject({ code: 'IDENTITY_PREFLIGHT_APP_MISMATCH' });
  });

  it('blocks a remote App mismatch without disclosing either App identity', async () => {
    const { provider } = await secretFixture();
    const fake = await fakeLarkServer({ applicationBody: { code: 0, data: { app: { app_id: 'cli_remote_private' } } } });
    const probe = new LarkIdentityPreflightProbe({ secretProvider: provider, baseUrlForBrand: () => fake.baseUrl });
    let caught: unknown;
    try { await probe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [] }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(IdentityPreflightError);
    expect(caught).toMatchObject({ code: 'IDENTITY_PREFLIGHT_APP_MISMATCH' });
    expect(JSON.stringify({ code: (caught as IdentityPreflightError).code, message: (caught as Error).message })).not.toContain('cli_remote_private');
  });

  it('maps rejected remote authentication to a safe code without echoing the upstream payload', async () => {
    const { provider } = await secretFixture();
    const fake = await fakeLarkServer({ tokenStatus: 401, tokenBody: { code: 401, msg: `${secretCanary} TOKEN_CANARY_DO_NOT_LEAK alice@example.com` } });
    const probe = new LarkIdentityPreflightProbe({ secretProvider: provider, baseUrlForBrand: () => fake.baseUrl });
    let caught: unknown;
    try { await probe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [] }); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'IDENTITY_PREFLIGHT_REMOTE_AUTH_FAILED' });
    expect(JSON.stringify({ code: (caught as IdentityPreflightError).code, message: (caught as Error).message })).not.toMatch(/SECRET_CANARY|TOKEN_CANARY|alice@example\.com/);
  });

  it('turns 403 and not-member responses into non-sensitive blockers', async () => {
    const first = await secretFixture();
    const forbidden = await fakeLarkServer({
      membershipStatus: 403,
      membershipBody: { code: 99991672, msg: `forbidden ${secretCanary} alice@example.com TOKEN_CANARY_DO_NOT_LEAK` },
    });
    const forbiddenProbe = new LarkIdentityPreflightProbe({ secretProvider: first.provider, baseUrlForBrand: () => forbidden.baseUrl });
    const forbiddenResult = await forbiddenProbe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [groupBinding()] });
    expect(forbiddenResult).toMatchObject({
      status: 'blocked',
      blockerCodes: ['IDENTITY_PREFLIGHT_CHAT_INACCESSIBLE'],
      chatFacts: [{ chatAccessible: false, membershipState: 'inaccessible', blockerCode: 'IDENTITY_PREFLIGHT_CHAT_INACCESSIBLE' }],
    });
    expect(JSON.stringify(forbiddenResult)).not.toMatch(/SECRET_CANARY|TOKEN_CANARY|alice@example\.com/);

    const second = await secretFixture();
    const absent = await fakeLarkServer({ membershipBody: { code: 0, data: { is_in_chat: false } } });
    const absentProbe = new LarkIdentityPreflightProbe({ secretProvider: second.provider, baseUrlForBrand: () => absent.baseUrl });
    const absentResult = await absentProbe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [groupBinding()] });
    expect(absentResult).toMatchObject({
      status: 'blocked',
      blockerCodes: ['IDENTITY_PREFLIGHT_CHAT_NOT_MEMBER'],
      chatFacts: [{ chatAccessible: false, membershipState: 'not_member', blockerCode: 'IDENTITY_PREFLIGHT_CHAT_NOT_MEMBER' }],
    });
  });

  it('keeps an inconclusive/non-group chat type blocked', async () => {
    const { provider } = await secretFixture();
    const fake = await fakeLarkServer({ chatBody: { code: 0, data: { chat_mode: 'p2p' } } });
    const probe = new LarkIdentityPreflightProbe({ secretProvider: provider, baseUrlForBrand: () => fake.baseUrl });
    const result = await probe.probe({ channelBot: channelBot(), secretRef: secretRef(), groupBindings: [groupBinding()] });
    expect(result).toMatchObject({
      status: 'blocked',
      blockerCodes: ['IDENTITY_PREFLIGHT_CHAT_TYPE_UNSUPPORTED'],
      chatFacts: [{ membershipState: 'member', chatType: 'unknown', blockerCode: 'IDENTITY_PREFLIGHT_CHAT_TYPE_UNSUPPORTED' }],
    });
  });

  it('rejects evidence TTLs beyond four hours', async () => {
    const { provider } = await secretFixture();
    expect(() => new LarkIdentityPreflightProbe({ secretProvider: provider, evidenceTtlMs: 4 * 60 * 60 * 1_000 + 1 }))
      .toThrow('within four hours');
  });
});
