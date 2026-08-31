import { describe, expect, it, vi } from 'vitest';
import { IdentityPreflightCliError, projectIdentityPreflightCliResult, runIdentityPreflightCli } from './identity-preflight-cli.js';
import { createCliProgram } from './cli-program.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiResult = {
  schemaVersion: 1,
  channelBotId: 'bot-1',
  status: 'passed',
  identityFact: {
    schemaVersion: 1, id: 'identity-1', revision: 1, channelBotId: 'bot-1', botIdentityRef: 'remote_bot_1234567890abcdef12345678',
    tenantRef: 'remote_tenant_1234567890abcdef12345678', appIdMatch: true, checkedAt: '2026-08-30T08:00:00.000Z', expiresAt: '2026-08-30T12:00:00.000Z',
    createdAt: '2026-08-30T08:00:00.000Z', updatedAt: '2026-08-30T08:00:00.000Z', validity: 'valid',
  },
  chatFacts: [{ groupBindingId: 'binding-1', fact: {
    schemaVersion: 1, id: 'chat-1', revision: 1, channelBotId: 'bot-1', membershipState: 'member', chatType: 'group',
    observedAt: '2026-08-30T08:00:00.000Z', lastSuccessAt: '2026-08-30T08:00:00.000Z', identityRevision: 1, credentialRevision: 1,
    expiresAt: '2026-08-30T12:00:00.000Z', createdAt: '2026-08-30T08:00:00.000Z', updatedAt: '2026-08-30T08:00:00.000Z', validity: 'valid',
  } }],
  blockerCodes: [], checkedAt: '2026-08-30T08:00:00.000Z', expiresAt: '2026-08-30T12:00:00.000Z', appMatch: true, tenantAppMatch: true,
  credentialFingerprint: 'SECRET_FINGERPRINT_CANARY', externalChatId: 'oc_private', displayName: 'alice@example.com', token: 'TOKEN_CANARY',
};

describe('identity preflight CLI', () => {
  it('parses the documented repeatable GroupBinding command exactly', async () => {
    const identityPreflight = vi.fn();
    await createCliProgram('test', { identityPreflight }).parseAsync([
      'node', 'dockmux', 'lark', 'preflight', 'bot-1', '--group-binding', 'binding-1', '--group-binding', 'binding-2',
    ]);
    expect(identityPreflight).toHaveBeenCalledWith('bot-1', expect.objectContaining({ groupBinding: ['binding-1', 'binding-2'] }));
  });

  it('authenticates token mode without exposing the token and re-projects the API allowlist', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => response(apiResult));
    const result = await runIdentityPreflightCli('bot-1', { groupBinding: ['binding-1'] }, {
      readState: () => ({ pid: 1, ready: true, startedAt: '', cwd: '', address: 'http://127.0.0.1:4310', database: '/private/db', authEnabled: true }),
      getAccessToken: async () => 'ACCESS_TOKEN_CANARY',
      fetcher: fetcher as typeof globalThis.fetch,
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/api/foundation/channel-bots/bot-1/identity-preflight', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer ACCESS_TOKEN_CANARY' }), body: JSON.stringify({ groupBindingIds: ['binding-1'] }),
    }));
    expect(result).toMatchObject({ action: 'identity_preflight', status: 'passed', identityFact: { validity: 'valid' }, chatFacts: [{ groupBindingId: 'binding-1' }], activationChanged: false, listenerReadiness: 'blocked' });
    expect(JSON.stringify(result)).not.toMatch(/ACCESS_TOKEN_CANARY|SECRET_FINGERPRINT_CANARY|TOKEN_CANARY|oc_private|alice@example\.com|credentialFingerprint|externalChatId|displayName/);
  });

  it('uses the explicit trusted no-auth daemon without an anonymous fallback in token mode', async () => {
    const openFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => response(apiResult));
    await runIdentityPreflightCli('bot-1', {}, {
      readState: () => ({ pid: 1, ready: true, startedAt: '', cwd: '', address: 'http://127.0.0.1:4310', authEnabled: false }),
      fetcher: openFetch as typeof globalThis.fetch,
    });
    expect((openFetch.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty('authorization');

    await expect(runIdentityPreflightCli('bot-1', {}, {
      readState: () => ({ pid: 1, ready: true, startedAt: '', cwd: '', address: 'http://127.0.0.1:4310', database: '/private/db', authEnabled: true }),
      getAccessToken: async () => null,
      fetcher: openFetch as typeof globalThis.fetch,
    })).rejects.toMatchObject({ code: 'IDENTITY_PREFLIGHT_AUTH_UNAVAILABLE' });
  });

  it('does not echo an upstream error body and rejects non-loopback daemon pointers', async () => {
    let caught: unknown;
    try {
      await runIdentityPreflightCli('bot-1', {}, {
        readState: () => ({ pid: 1, ready: true, startedAt: '', cwd: '', address: 'http://127.0.0.1:4310', authEnabled: false }),
        fetcher: (async () => response({ error: { code: 'IDENTITY_PREFLIGHT_CHAT_INACCESSIBLE', message: 'SECRET TOKEN alice@example.com' } }, 409)) as typeof globalThis.fetch,
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(IdentityPreflightCliError);
    expect(JSON.stringify({ code: (caught as IdentityPreflightCliError).code, message: (caught as Error).message })).not.toMatch(/SECRET|TOKEN|alice@example\.com/);

    await expect(runIdentityPreflightCli('bot-1', {}, {
      readState: () => ({ pid: 1, ready: true, startedAt: '', cwd: '', address: 'https://attacker.invalid', authEnabled: false }),
    })).rejects.toMatchObject({ code: 'IDENTITY_PREFLIGHT_DAEMON_ADDRESS_INVALID' });
  });

  it('rejects malformed API success data instead of forwarding unknown fields', () => {
    expect(() => projectIdentityPreflightCliResult({ ok: true, secret: 'SECRET_CANARY' })).toThrowError(expect.objectContaining({ code: 'IDENTITY_PREFLIGHT_RESPONSE_INVALID' }));
  });
});
