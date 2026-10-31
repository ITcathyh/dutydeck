import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, installationOwnerTaskActor } from '@dutydeck/shared';
import type { DriverFactory, RuntimeOptions } from '@dutydeck/runtime';
import { AUTH_COOKIE_NAME, AUTH_PASSWORD_CONFIG_KEY, getAuthToken, getShareLinkSecret, hashPassword, issueBrowserSession, signSessionShareToken } from './auth/auth.js';
import { larkBotsConfigKey } from './lark/config.js';
import { LarkGroupManager } from './lark/group-management.js';
import { startLocalServer } from './service.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('TCP address missing');
    server.close(() => resolve(address.port));
  });
});
async function fixture(mode: 'local' | 'token') {
  const directory = mkdtempSync(join(tmpdir(), 'dutydeck-owner-wiring-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'state.db');
  const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' }); cleanups.push(() => repos.close());
  const password = await hashPassword('owner-routing-test-password');
  await repos.config.set(AUTH_PASSWORD_CONFIG_KEY, password);
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_owner', appSecret: 'fixture-secret', defaultAgentId: 'fake', workspace: directory, listening: true, fullTrustConfirmed: true }]));
  const port = await freePort();
  const service = await startLocalServer({ webRoot: directory, env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: 'test',
    DUTYDECK_HOST: mode === 'local' ? '127.0.0.1' : '0.0.0.0', DUTYDECK_PORT: String(port), DUTYDECK_DEFAULT_CWD: directory,
    DUTYDECK_DATABASE_URL: database, DUTYDECK_DAEMON_DIR: join(directory, 'daemon'), DUTYDECK_AUTH: 'true',
    DUTYDECK_DISABLE_LARK_LISTENER: 'true', DUTYDECK_AGENTS_JSON: '[]' } });
  cleanups.push(() => service.close());
  const internals = service.runtime as unknown as { factory: DriverFactory; options: RuntimeOptions };
  internals.options.probe = () => ({ protocol: 'acp', available: true, pause: false, resume: true });
  const send = vi.fn(async () => {});
  internals.factory = () => ({ start: async () => {}, stop: async () => {}, isStopped: async () => true, isIdle: () => true, hasBackgroundWork: () => false, send, interrupt: async () => {} });
  await repos.agents.save(agentConfigSchema.parse({ id: 'fake', name: 'Fake', command: 'fake', protocol: 'acp', cwd: directory }));
  service.runtime.setQueueHeld(true);
  const base = `http://127.0.0.1:${port}`;
  const token = await getAuthToken(repos.config);
  const owner = { authorization: `Bearer ${token}` };
  const browser = { cookie: `${AUTH_COOKIE_NAME}=${issueBrowserSession(password)}` };
  const request = (path: string, method = 'POST', headers: Record<string, string> = owner) => fetch(`${base}${path}`, { method, headers: { origin: base, ...headers } });
  const queue = async (source: 'lark' | 'web' = 'lark') => {
    const session = await service.runtime.start({ agentId: 'fake', source, ...(source === 'lark' ? { sourceId: 'cli_owner:oc_owner:group' } : {}) });
    const task = await service.runtime.dispatch(session.id, 'held request', 'queue', undefined, undefined, installationOwnerTaskActor);
    expect(task.status).toBe('queued');
    return { session, task, url: `/api/sessions/${session.id}/queue/${task.id}` };
  };
  return { repos, service, queue, request, owner, browser, send, database, directory };
}

it.each([
  ['token', 'lark', 'owner'], ['token', 'web', 'browser'], ['local', 'lark', 'local'], ['local', 'web', 'owner']
] as const)('real %s service preserves %s session control for the verified %s owner', async (mode, source, identity) => {
  const f = await fixture(mode);
  const headers = identity === 'local' ? {} : f[identity];
  for (const action of ['cancel', 'stop', 'archive'] as const) {
    const { session, task, url } = await f.queue(source);
    const response = await f.request(action === 'cancel' ? url : `/api/sessions/${session.id}/${action}`, action === 'cancel' ? 'DELETE' : 'POST', headers);
    expect(response.status, `${action}: ${JSON.stringify(await response.clone().json())}`).toBe(200);
    expect((await f.repos.tasks.get!(task.id))?.status).toBe('cancelled');
    const sql = new Database(f.database, { readonly: true });
    try {
      const decisions = sql.prepare('SELECT json FROM recovery_decisions WHERE session_id=?').all(session.id) as Array<{ json: string }>;
      expect(decisions.map(row => JSON.parse(row.json).evidence.actor)).toContainEqual({ kind: 'installation_owner', id: installationOwnerTaskActor });
    } finally { sql.close(); }
  }
  expect(f.send).not.toHaveBeenCalled();
});

it.each(['local', 'token'] as const)('real %s wiring never promotes task credentials or share access to owner control', async mode => {
  const f = await fixture(mode); const h = await f.queue();
  const share = signSessionShareToken((await getShareLinkSecret(f.repos.config))!, h.session.id);
  expect((await f.request(`/api/sessions/${h.session.id}?share=${share}`, 'GET', {})).status).toBe(200);
  const credentials = [
    { authorization: 'Bearer v1.session-capability' }, { authorization: 'Bearer unrecognized-attempt-token' },
    ...['x-dutydeck-tool-turn', 'x-dutydeck-work-turn', 'x-dutydeck-result-turn'].map(header => ({ ...f.owner, [header]: 'attempt-token' }))
  ];
  for (const headers of credentials) {
    const response = await f.request(h.url, 'DELETE', headers);
    expect([401, 403, 409]).toContain(response.status);
    expect((await f.repos.tasks.get!(h.task.id))?.status).toBe('queued');
  }
  expect((await f.request(`${h.url}?share=${share}`, 'DELETE')).status).toBe(401);
  expect((await f.repos.tasks.get!(h.task.id))?.status).toBe('queued');
  expect(f.send).not.toHaveBeenCalled();
});

it('real owner wiring preserves managed policy denials and work-item control boundaries', async () => {
  const f = await fixture('token');
  await f.repos.channelBots.create({ id: 'staged-bot', channel: 'lark', externalAppId: 'cli_staged', displayName: 'Staged', brand: 'feishu', state: 'staged' });
  await f.repos.groupBindings.create({ id: 'staged-binding', channelBotId: 'staged-bot', externalChatId: 'oc_staged' });
  const execution = (f.service.runtime as any).bound();
  for (const [id, source, sourceId, expected] of [
    ['managed', 'foundation_group_binding', 'staged-binding', 'channel_bot_disabled'],
    ['work-child', 'work_item', 'work-attempt', 'WORK_ITEM_MANAGED_SESSION']
  ]) {
    execution.createSession({ id, runId: `run-${id}`, agentId: 'fake', cwd: f.directory, state: 'idle', source, sourceId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const response = await f.request(`/api/sessions/${id}/stop`);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe(expected);
    expect((await f.repos.sessions.get(id))?.state).toBe('idle');
  }
});

it('a live group owner policy cannot promote task credentials or override a group denial', async () => {
  const f = await fixture('token'); const h = await f.queue();
  const groups = new LarkGroupManager(f.repos, { client: () => ({
    getBotInfo: async () => ({ appName: 'Owner fixture', openId: 'ou_fixture_bot' }),
    checkApplicationIdentity: async () => ({ verified: true, reportedAppId: 'cli_owner' }),
    listChats: async () => ({ items: [{ chatId: 'oc_owner', name: 'Owner fixture' }], hasMore: false })
  }) as any });
  await groups.sync('cli_owner');
  const detail = await groups.save('cli_owner', 'oc_owner', { expectedRevision: 0, patch: {} });
  expect(await groups.authorizeSession(h.session.id, 'queue.cancel', true)).toMatchObject({ allowed: true, source: 'owner' });
  const task = await f.request(h.url, 'DELETE', { ...f.owner, 'x-dutydeck-tool-turn': 'attempt-token' });
  expect(task.status).toBe(403);
  expect((await f.repos.tasks.get!(h.task.id))?.status).toBe('queued');
  await groups.save('cli_owner', 'oc_owner', { expectedRevision: detail.binding!.revision, patch: { accessOverride: { mode: 'disabled' } } });
  const denied = await f.request(h.url, 'DELETE');
  expect(denied.status).toBe(403);
  expect((await f.repos.tasks.get!(h.task.id))?.status).toBe('queued');
});
