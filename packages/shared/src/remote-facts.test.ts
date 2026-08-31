import { describe, expect, it } from 'vitest';
import {
  REMOTE_FACT_EXPIRED_AT,
  remoteChatFactSchema,
  remoteChatFactValidity,
  remoteIdentityFactSchema,
  toPublicRemoteChatFact,
  toPublicRemoteIdentityFact
} from './index.js';

const checkedAt = '2026-08-30T00:00:00.000Z';
const expiresAt = '2026-08-30T01:00:00.000Z';
const credentialFingerprint = 'a'.repeat(64);

function identity(overrides: Record<string, unknown> = {}) {
  return remoteIdentityFactSchema.parse({
    schemaVersion: 1,
    id: 'identity-1',
    revision: 1,
    channelBotId: 'bot-1',
    credentialRefId: 'secret-1',
    credentialRevision: 2,
    credentialFingerprint,
    appFingerprint: 'b'.repeat(64),
    botIdentityRef: `remote_bot_${'c'.repeat(24)}`,
    tenantRef: `remote_tenant_${'d'.repeat(24)}`,
    appIdMatch: true,
    checkedAt,
    expiresAt,
    createdAt: checkedAt,
    updatedAt: checkedAt,
    ...overrides
  });
}

function chat(overrides: Record<string, unknown> = {}) {
  return remoteChatFactSchema.parse({
    schemaVersion: 1,
    id: 'chat-1',
    revision: 1,
    channelBotId: 'bot-1',
    externalChatId: 'synthetic-sensitive-chat-ref',
    membershipState: 'member',
    chatType: 'group',
    displayName: 'Synthetic Sensitive Group',
    observedAt: checkedAt,
    credentialRefId: 'secret-1',
    credentialRevision: 2,
    credentialFingerprint,
    identityFactId: 'identity-1',
    identityRevision: 1,
    expiresAt,
    createdAt: checkedAt,
    updatedAt: checkedAt,
    ...overrides
  });
}

describe('remote identity and chat fact contracts', () => {
  it('rejects plaintext credential, app and PII fields at the identity boundary', () => {
    const base = identity();
    for (const forbidden of ['accessToken', 'appSecret', 'appId', 'botName', 'tenantName', 'displayName']) {
      expect(() => remoteIdentityFactSchema.parse({ ...base, [forbidden]: `canary-${forbidden}` })).toThrow();
    }
    expect(() => remoteIdentityFactSchema.parse({ ...base, credentialFingerprint: 'not-a-sha256' })).toThrow();
    expect(() => remoteIdentityFactSchema.parse({ ...base, botIdentityRef: 'ou_plain_remote_identity' })).toThrow();
  });

  it('exposes only allowlisted identity and chat metadata', () => {
    const publicIdentity = toPublicRemoteIdentityFact(identity(), new Date(checkedAt));
    const publicChat = toPublicRemoteChatFact(chat(), identity(), new Date(checkedAt));
    const serialized = JSON.stringify({ publicIdentity, publicChat });

    expect(publicIdentity.validity).toBe('valid');
    expect(publicChat.validity).toBe('valid');
    expect(serialized).not.toContain('secret-1');
    expect(serialized).not.toContain(credentialFingerprint);
    expect(serialized).not.toContain('synthetic-sensitive-chat-ref');
    expect(serialized).not.toContain('Synthetic Sensitive Group');
  });

  it('fails closed for legacy, expired, mismatched and invalidated chat facts', () => {
    const currentIdentity = identity();
    expect(remoteChatFactValidity(chat(), currentIdentity, new Date(checkedAt))).toBe('valid');
    expect(remoteChatFactValidity(chat({ expiresAt: REMOTE_FACT_EXPIRED_AT, credentialRefId: undefined, credentialRevision: undefined, credentialFingerprint: undefined, identityFactId: undefined, identityRevision: undefined }), undefined, new Date(checkedAt))).toBe('expired');
    expect(remoteChatFactValidity(chat(), identity({ revision: 2 }), new Date(checkedAt))).toBe('identity_mismatch');
    expect(remoteChatFactValidity(chat(), identity({ appIdMatch: false, errorCode: 'REMOTE_APP_ID_MISMATCH' }), new Date(checkedAt))).toBe('app_mismatch');
    expect(remoteChatFactValidity(chat({ invalidatedAt: checkedAt }), currentIdentity, new Date(checkedAt))).toBe('invalidated');
  });
});
