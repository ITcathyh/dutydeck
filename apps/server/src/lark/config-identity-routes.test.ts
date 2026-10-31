import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { buildApp } from '../app.js';
import { larkBotsConfigKey, readLarkConfig } from './config.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(contact: 'invalid' | 'valid' | 'scope' | 'network' = 'invalid', extra = {}, names: 'valid' | 'ambiguous' | 'scope' = 'valid') {
  const repos = createRepositories(':memory:'); cleanups.push(() => repos.close());
  await repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_source', appSecret: 'source-secret', defaultAgentId: 'codex', permissionMode: 'ask', allowedUsers: [{ openId: 'ou_owner', name: 'Owner' }], revision: 4, ...extra }]));
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const address = String(url);
    if (address.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'target-token', expire: 7200 });
    if (address.includes('/bot/v3/info')) return Response.json({ code: 0, bot: { app_name: 'Target', open_id: 'ou_target_bot' } });
    if (address.includes('/members/list')) {
      if (names === 'scope') return Response.json({ code: 99991672, msg: 'scope unavailable' });
      const members = new URL(address).searchParams.get('member_types') === 'bot'
        ? [{ member_id: 'ou_target_peer', name: 'Peer', member_type: 'bot' }, ...(names === 'ambiguous' ? [{ member_id: 'ou_other_peer', name: 'Peer', member_type: 'bot' }] : [])]
        : [{ member_id: 'ou_target_owner', name: 'Owner' }, { member_id: 'ou_target_approver', name: 'Approver' }];
      return Response.json({ code: 0, data: { items: members, has_more: false } });
    }
    if (address.includes('/im/v1/chats?')) return Response.json({ code: 0, data: { items: [{ chat_id: 'oc_fixture', name: 'Fixture' }], has_more: false } });
    if (address.includes('/contact/')) {
      if (contact === 'network') throw new Error('network unavailable');
      if (contact === 'valid') return Response.json({ code: 0, data: { user: { open_id: 'ou_owner', name: 'Owner' } } });
      return Response.json({ code: contact === 'scope' ? 99991672 : 99992361, msg: contact });
    }
    throw new Error(`Unexpected request: ${address}`);
  });
  const app = await buildApp({} as any, { lark: { config: repos.config, listeningDisabled: true, env: {}, fetcher } });
  cleanups.push(() => app.close());
  await readLarkConfig(repos.config, 'cli_source');
  return { app, repos, fetcher };
}

describe('final bot application identity', () => {
  for (const stage of ['lark', 'agent'] as const) for (const explicit of [false, true]) {
    it(`rejects a foreign ${explicit ? 'explicit' : 'inherited'} owner in the ${stage} stage without changing config`, async () => {
      const { app, repos, fetcher } = await fixture();
      const before = await repos.config.get(larkBotsConfigKey);
      const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: {
        stage, originalAppId: 'cli_source', appId: 'cli_target', appSecret: 'target-secret', expectedRevision: 4,
        ...(explicit ? { allowedUsers: [{ openId: 'ou_owner', name: 'Owner' }] } : {})
      } });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('LARK_OWNER_OPENID_CROSS_APP');
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('/contact/'))).toBe(true);
      expect(await repos.config.get(larkBotsConfigKey)).toBe(before);
      expect(await readLarkConfig(repos.config, 'cli_target')).toBeUndefined();
    });
  }

  for (const stage of ['lark', 'agent'] as const) {
    it(`normalizes the source app ID before checking inherited owners in the ${stage} stage`, async () => {
      const { app, repos, fetcher } = await fixture();
      const before = await repos.config.get(larkBotsConfigKey);
      const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: {
        stage, originalAppId: ' cli_source ', appId: 'cli_target', appSecret: 'target-secret', expectedRevision: 4
      } });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('LARK_OWNER_OPENID_CROSS_APP');
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/contact/'))).toHaveLength(1);
      expect(await repos.config.get(larkBotsConfigKey)).toBe(before);
      expect((await readLarkConfig(repos.config, 'cli_source'))?.revision).toBe(4);
      expect(await readLarkConfig(repos.config, 'cli_target')).toBeUndefined();
    });
  }

  for (const stage of ['lark', 'agent'] as const) {
    it(`saves a target-app owner in the ${stage} stage`, async () => {
      const { app, repos } = await fixture('valid');
      const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage, originalAppId: 'cli_source', appId: 'cli_target', appSecret: 'target-secret', expectedRevision: 4 } });
      expect(result.statusCode).toBe(200);
      expect(await readLarkConfig(repos.config, 'cli_target')).toMatchObject({ allowedUsers: [{ openId: 'ou_owner' }], revision: 5 });
    });
    it(`does not query inherited owners for ordinary same-app ${stage} edits`, async () => {
      const { app, fetcher } = await fixture();
      const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage, originalAppId: 'cli_source', expectedRevision: 4, traceLimit: 24 } });
      expect(result.statusCode).toBe(200);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/contact/'))).toHaveLength(0);
    });
  }

  for (const contact of ['scope', 'network'] as const) it(`preserves inconclusive ${contact} checks`, async () => {
    const { app } = await fixture(contact);
    const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_source', appId: 'cli_target', appSecret: 'target-secret' } });
    expect(result.statusCode).toBe(200);
  });

  it('checks inherited high-risk users against the final application', async () => {
    const { app, repos } = await fixture('invalid', { allowedUsers: [], highRiskAllowedUsers: [{ openId: 'ou_high_risk', name: 'Approver' }] });
    const before = await repos.config.get(larkBotsConfigKey);
    const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_source', appId: 'cli_target', appSecret: 'target-secret' } });
    expect(result.statusCode).toBe(400);
    expect(await repos.config.get(larkBotsConfigKey)).toBe(before);
  });

  it('requires target application resolution before transferring a bot allowlist', async () => {
    const { app, repos } = await fixture('invalid', { allowedUsers: [], allowedBots: [{ openId: 'ou_peer_bot', name: 'Peer' }] });
    const before = await repos.config.get(larkBotsConfigKey);
    const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_source', appId: 'cli_target', appSecret: 'target-secret' } });
    expect(result.statusCode).toBe(400);
    expect(await repos.config.get(larkBotsConfigKey)).toBe(before);
  });

  it('resolves every name list with the target application in the Agent stage', async () => {
    const { app, repos, fetcher } = await fixture('invalid', { allowedBots: [{ openId: 'ou_foreign_peer' }], highRiskAllowedUsers: [{ openId: 'ou_foreign_approver' }] });
    const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_source', appId: 'cli_target', appSecret: 'target-secret', allowedUserNames: ['Owner'], allowedBotNames: ['Peer'], highRiskAllowedUserNames: ['Approver'] } });
    expect(result.statusCode).toBe(200);
    expect(await readLarkConfig(repos.config, 'cli_target')).toMatchObject({ allowedUsers: [{ openId: 'ou_target_owner' }], allowedBots: [{ openId: 'ou_target_peer' }], highRiskAllowedUsers: [{ openId: 'ou_target_approver' }] });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/contact/'))).toHaveLength(0);
  });

  it('allows clearing inherited peer bots explicitly when switching applications', async () => {
    const { app, repos } = await fixture('valid', { allowedBots: [{ openId: 'ou_foreign_peer' }] });
    const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_source', appId: 'cli_target', appSecret: 'target-secret', allowedBots: [] } });
    expect(result.statusCode).toBe(200);
    expect((await readLarkConfig(repos.config, 'cli_target'))?.allowedBots).toEqual([]);
  });

  for (const names of ['ambiguous', 'scope'] as const) it(`retains ${names} name resolution rejection without changing config`, async () => {
    const { app, repos } = await fixture('invalid', { allowedUsers: [] }, names);
    const before = await repos.config.get(larkBotsConfigKey);
    const result = await app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId: 'cli_source', appId: 'cli_target', appSecret: 'target-secret', allowedBotNames: ['Peer'] } });
    expect(result.statusCode).toBe(names === 'ambiguous' ? 409 : 502);
    if (names === 'ambiguous') expect(result.json().error.code).toBe('LARK_USER_NAME_AMBIGUOUS');
    expect(await repos.config.get(larkBotsConfigKey)).toBe(before);
  });

  it.each(['cli_source', ' cli_source '])('rejects a stale inheritance snapshot for source %j during target lookup', async originalAppId => {
    const { app, repos, fetcher } = await fixture('valid');
    const upstream = fetcher.getMockImplementation()!;
    let release!: () => void, started!: () => void;
    const atContact = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementation(async url => { if (String(url).includes('/contact/')) { started(); await resume; } return upstream(url); });
    const pending = app.inject({ method: 'PUT', url: '/api/lark/config', payload: { stage: 'agent', originalAppId, appId: 'cli_target', appSecret: 'target-secret' } });
    // Fastify injection starts when observed as a promise.
    const response = Promise.resolve(pending);
    await atContact;
    const configs = JSON.parse((await repos.config.get(larkBotsConfigKey))!);
    configs[0].allowedUsers = [{ openId: 'ou_new_owner', name: 'New owner' }]; configs[0].revision = 5;
    await repos.config.set(larkBotsConfigKey, JSON.stringify(configs));
    const before = await repos.config.get(larkBotsConfigKey);
    release();
    expect((await response).statusCode).toBe(409);
    expect(await repos.config.get(larkBotsConfigKey)).toBe(before);
  });

});
