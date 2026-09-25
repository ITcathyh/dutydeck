import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LocalFileSecretProvider, secretDirectoryForDatabase } from '@dutydeck/secret-provider';
import { getAuthToken } from './auth/auth.js';
import { startLocalServer, type LocalServer } from './service.js';

const roots: string[] = [];
const services: LocalServer[] = [];
const closeServers: Array<() => Promise<void>> = [];
const remoteCanaries = ['TOKEN_REMOTE_CANARY', 'ou_remote_private', 'tenant_remote_private', 'Remote Private Bot', 'Remote Private Chat', 'alice@example.com'];
const secretCanary = 'SECRET_LOCAL_CANARY';

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('expected TCP address'));
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});

async function fakeLark() {
  const requests: Array<{ method?: string; url?: string; body: string }> = [];
  let barrierTarget = 0;
  let barrierCount = 0;
  let releaseBarrier: (() => void) | undefined;
  let barrier = Promise.resolve();
  let authenticationRejected = false;
  const armChatBarrier = (count: number) => {
    barrierTarget = count;
    barrierCount = 0;
    barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
  };
  const server = createHttpServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (request.url === '/open-apis/auth/v3/tenant_access_token/internal/') return authenticationRejected
      ? send(401, { code: 401, msg: 'TOKEN_REMOTE_CANARY alice@example.com' })
      : send(200, { code: 0, tenant_access_token: 'TOKEN_REMOTE_CANARY', expire: 7200 });
    if (request.url?.startsWith('/open-apis/application/v6/applications/')) return send(200, { code: 0, data: { app: { app_id: 'cli_service_preflight', tenant_key: 'tenant_remote_private' } } });
    if (request.url === '/open-apis/bot/v3/info') return send(200, { code: 0, bot: { app_name: 'Remote Private Bot', open_id: 'ou_remote_private' } });
    if (request.url?.endsWith('/members/is_in_chat')) return send(200, { code: 0, data: { is_in_chat: true } });
    if (request.url?.startsWith('/open-apis/im/v1/chats/')) {
      if (barrierTarget > 0) {
        barrierCount++;
        if (barrierCount >= barrierTarget) releaseBarrier?.();
        await barrier;
      }
      return send(200, { code: 0, data: { name: 'Remote Private Chat', chat_mode: 'group', chat_status: 'normal' } });
    }
    return send(404, { code: 404, msg: 'unexpected fake route alice@example.com' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake server did not bind');
  const close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeServers.push(close);
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, armChatBarrier, rejectAuthentication: () => { authenticationRejected = true; } };
}

async function seed(database: string) {
  const repositories = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  try {
    const reference = await repositories.secretRefs.create({
      id: 'secret-preflight', kind: 'lark_app_secret', provider: 'local-file-v1', referenceKey: 'service.preflight', status: 'configured',
    });
    await repositories.channelBots.create({
      id: 'bot-preflight', channel: 'lark', externalAppId: 'cli_service_preflight', displayName: 'Service Bot', brand: 'feishu', credentialRef: reference.id, state: 'staged',
    });
    await repositories.groupBindings.create({ id: 'binding-preflight', channelBotId: 'bot-preflight', externalChatId: 'oc_service_private', oncall: true });
  } finally { repositories.close(); }
  const provider = new LocalFileSecretProvider(secretDirectoryForDatabase(database), { createDirectory: true });
  provider.writeExclusive('service.preflight', Buffer.from(JSON.stringify({
    schema_version: 1, kind: 'lark_app_credential', app_id: 'cli_service_preflight', app_secret: secretCanary,
  })));
}

async function start(root: string, database: string, port: number, baseUrl: string, auth: boolean, now: Date) {
  const service = await startLocalServer({
    webRoot: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DUTYDECK_HOST: '0.0.0.0',
      DUTYDECK_PORT: String(port),
      DUTYDECK_DEFAULT_CWD: root,
      DUTYDECK_DATABASE_URL: database,
      DUTYDECK_AUTH: String(auth),
      // auth=false 的这一轮就是在 0.0.0.0 上免认证运行：显式确认，否则启动保护会拒绝。
      DUTYDECK_UNSAFE_NO_AUTH: 'true',
      DUTYDECK_DISABLE_LARK_LISTENER: 'true',
      DUTYDECK_AGENTS_JSON: '[]',
    },
    identityPreflight: { baseUrlForBrand: () => baseUrl, now: () => now },
  });
  services.push(service);
  return service;
}

async function closeTracked(service: LocalServer) {
  const index = services.indexOf(service);
  if (index >= 0) services.splice(index, 1);
  await service.close();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(closeServers.splice(0).map(close => close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production identity preflight wiring', () => {
  it('persists allowlisted CAS facts, survives restart, expires closed, and never activates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-preflight-service-'));
    roots.push(root);
    const database = join(root, 'dutydeck.db');
    await seed(database);
    const fake = await fakeLark();
    const firstPort = await freePort();
    const first = await start(root, database, firstPort, fake.baseUrl, false, new Date('2026-08-30T08:00:00.000Z'));
    const base = `http://127.0.0.1:${firstPort}`;
    expect(fake.requests).toHaveLength(0);

    const response = await fetch(`${base}/api/foundation/channel-bots/bot-preflight/identity-preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupBindingIds: ['binding-preflight'] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      schemaVersion: 1,
      channelBotId: 'bot-preflight',
      status: 'passed',
      identityFact: { revision: 1, botIdentityRef: expect.stringMatching(/^remote_bot_[a-f0-9]{24}$/), tenantRef: expect.stringMatching(/^remote_tenant_[a-f0-9]{24}$/), appIdMatch: true, validity: 'valid' },
      chatFacts: [{ groupBindingId: 'binding-preflight', fact: { revision: 1, membershipState: 'member', validity: 'valid' } }],
      activationChanged: false,
      listenerReadiness: 'blocked',
      remainingBlockers: ['listener_lease', 'activation_unavailable'],
    });
    for (const forbiddenField of ['credentialFingerprint', 'appFingerprint', 'credentialRefId', 'externalChatId', 'displayName']) expect(JSON.stringify(body)).not.toContain(forbiddenField);
    for (const canary of [secretCanary, ...remoteCanaries, 'oc_service_private']) expect(JSON.stringify(body)).not.toContain(canary);

    const repositories = createRepositories(database);
    const identity = await repositories.remoteIdentityFacts.getByChannelBot('bot-preflight');
    const chat = await repositories.remoteChatFacts.getByNaturalKey('bot-preflight', 'oc_service_private');
    const bot = await repositories.channelBots.get('bot-preflight');
    expect(identity).toMatchObject({ revision: 1, credentialRefId: 'secret-preflight', credentialRevision: 1, appIdMatch: true });
    expect(identity?.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(chat).toMatchObject({ revision: 1, identityFactId: identity?.id, identityRevision: 1, membershipState: 'member' });
    expect(bot).toMatchObject({ state: 'staged', desiredListenerState: 'disabled', fullTrustConfirmed: false });
    repositories.close();

    // Both requests captured revision 1 before their remote reads. Exactly one
    // may update it; the other receives current state for a safe retry.
    fake.armChatBarrier(2);
    const concurrent = await Promise.all([1, 2].map(() => fetch(`${base}/api/foundation/channel-bots/bot-preflight/identity-preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })));
    expect(concurrent.map(item => item.status).sort()).toEqual([200, 409]);
    const conflictResponse = concurrent.find(item => item.status === 409)!;
    expect(await conflictResponse.json()).toMatchObject({
      error: { code: 'FOUNDATION_REVISION_CONFLICT' },
      current: { identityFact: { revision: 2 }, activationChanged: false, listenerReadiness: 'blocked' },
    });

    // A later definitive preflight failure CAS-invalidates the last successful
    // identity and its chat facts instead of leaving stale success eligible.
    fake.rejectAuthentication();
    const rejected = await fetch(`${base}/api/foundation/channel-bots/bot-preflight/identity-preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(rejected.status).toBe(502);
    expect(await rejected.json()).toMatchObject({
      error: { code: 'IDENTITY_PREFLIGHT_REMOTE_AUTH_FAILED' },
      current: { status: 'blocked', identityFact: { errorCode: 'IDENTITY_PREFLIGHT_REMOTE_AUTH_FAILED' }, listenerReadiness: 'blocked' },
      activationChanged: false,
    });

    await closeTracked(first);
    const databaseBytes = [database, `${database}-wal`, `${database}-shm`]
      .filter(existsSync).map(path => readFileSync(path).toString('utf8')).join('\n');
    for (const canary of [secretCanary, ...remoteCanaries]) expect(databaseBytes).not.toContain(canary);

    const callsBeforeRestart = fake.requests.length;
    const secondPort = await freePort();
    const second = await start(root, database, secondPort, fake.baseUrl, false, new Date('2026-08-30T12:00:00.001Z'));
    const current = await fetch(`http://127.0.0.1:${secondPort}/api/foundation/channel-bots/bot-preflight/identity-preflight`);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ status: 'blocked', identityFact: { validity: 'expired' }, activationChanged: false, listenerReadiness: 'blocked' });
    expect(fake.requests).toHaveLength(callsBeforeRestart);
    await closeTracked(second);
  });

  it('requires a verified access token in token mode and accepts the trusted no-auth path separately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-preflight-token-'));
    roots.push(root);
    const database = join(root, 'dutydeck.db');
    await seed(database);
    const fake = await fakeLark();
    const port = await freePort();
    const service = await start(root, database, port, fake.baseUrl, true, new Date('2026-08-30T08:00:00.000Z'));
    const url = `http://127.0.0.1:${port}/api/foundation/channel-bots/bot-preflight/identity-preflight`;
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const repositories = createRepositories(database);
    const token = await getAuthToken(repositories.config);
    repositories.close();
    expect(token).toBeTruthy();
    expect((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
    await closeTracked(service);
  });
});
