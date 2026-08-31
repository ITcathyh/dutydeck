import { describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';

const checkedAt = '2026-08-30T00:00:00.000Z';
const expiresAt = '2026-08-30T01:00:00.000Z';
const credentialFingerprint = 'a'.repeat(64);

async function setup() {
  const repositories = createRepositories(':memory:');
  const secret = await repositories.secretRefs.create({
    id: 'secret-remote', kind: 'lark_app_secret', provider: 'keychain', referenceKey: 'synthetic/remote', status: 'configured'
  });
  await repositories.channelBots.create({
    id: 'bot-remote', channel: 'lark', externalAppId: 'synthetic-app', displayName: 'Synthetic Bot', brand: 'feishu',
    credentialRef: secret.id, state: 'staged'
  });
  return { repositories, secret };
}

function identityInput(expectedRevision = 0, overrides: Record<string, unknown> = {}) {
  return {
    id: 'identity-remote', expectedRevision, channelBotId: 'bot-remote', credentialRefId: 'secret-remote',
    credentialRevision: 1, credentialFingerprint, appFingerprint: 'b'.repeat(64),
    botIdentityRef: `remote_bot_${'c'.repeat(24)}`, tenantRef: `remote_tenant_${'d'.repeat(24)}`,
    appIdMatch: true, checkedAt, expiresAt, ...overrides
  };
}

function chatInput(expectedRevision = 0, overrides: Record<string, unknown> = {}) {
  return {
    id: 'chat-remote', expectedRevision, channelBotId: 'bot-remote', externalChatId: 'synthetic-chat',
    membershipState: 'member' as const, chatType: 'group' as const, observedAt: checkedAt, lastSuccessAt: checkedAt,
    credentialRefId: 'secret-remote', credentialRevision: 1, credentialFingerprint,
    identityFactId: 'identity-remote', identityRevision: 1, expiresAt, ...overrides
  };
}

describe('v14 remote fact repositories', () => {
  it('uses CAS for identity and chat upserts and fails closed after expiry', async () => {
    const { repositories } = await setup();
    const identity = await repositories.remoteIdentityFacts.upsert(identityInput());
    const chat = await repositories.remoteChatFacts.upsert(chatInput());

    expect(identity).toMatchObject({ revision: 1, channelBotId: 'bot-remote', appIdMatch: true });
    expect(chat).toMatchObject({ revision: 1, identityRevision: 1, credentialRevision: 1 });
    expect(await repositories.remoteIdentityFacts.getCurrentByChannelBot('bot-remote', '2026-08-30T00:30:00.000Z')).toMatchObject({ id: identity.id });
    expect(await repositories.remoteChatFacts.getCurrentByNaturalKey('bot-remote', 'synthetic-chat', '2026-08-30T00:30:00.000Z')).toMatchObject({ id: chat.id });
    expect(await repositories.remoteChatFacts.getCurrentByNaturalKey('bot-remote', 'synthetic-chat', '2026-08-30T02:00:00.000Z')).toBeUndefined();
    await expect(repositories.remoteIdentityFacts.upsert(identityInput(0))).rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });
    await expect(repositories.remoteChatFacts.upsert(chatInput(0))).rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });
    repositories.close();
  });

  it('invalidates bound chat facts when an identity recheck reports app mismatch', async () => {
    const { repositories } = await setup();
    await repositories.remoteIdentityFacts.upsert(identityInput());
    await repositories.remoteChatFacts.upsert(chatInput());

    const mismatch = await repositories.remoteIdentityFacts.upsert(identityInput(1, {
      appIdMatch: false,
      errorCode: 'REMOTE_APP_ID_MISMATCH',
      checkedAt: '2026-08-30T00:10:00.000Z'
    }));

    expect(mismatch).toMatchObject({ revision: 2, appIdMatch: false, errorCode: 'REMOTE_APP_ID_MISMATCH' });
    expect(await repositories.remoteIdentityFacts.getCurrentByChannelBot('bot-remote', checkedAt)).toBeUndefined();
    expect(await repositories.remoteChatFacts.get('chat-remote')).toMatchObject({ revision: 2, errorCode: 'REMOTE_APP_ID_MISMATCH', invalidatedAt: expect.any(String) });
    expect(await repositories.remoteChatFacts.getCurrentByNaturalKey('bot-remote', 'synthetic-chat', checkedAt)).toBeUndefined();
    repositories.close();
  });

  it('uses CAS for explicit invalidation and never returns invalidated facts as current', async () => {
    const { repositories } = await setup();
    await repositories.remoteIdentityFacts.upsert(identityInput());
    await repositories.remoteChatFacts.upsert(chatInput());
    await expect(repositories.remoteChatFacts.invalidate('chat-remote', {
      expectedRevision: 2, invalidatedAt: '2026-08-30T00:20:00.000Z', errorCode: 'REMOTE_CHAT_INVALIDATED'
    })).rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });

    const invalidated = await repositories.remoteChatFacts.invalidate('chat-remote', {
      expectedRevision: 1, invalidatedAt: '2026-08-30T00:20:00.000Z', errorCode: 'REMOTE_CHAT_INVALIDATED'
    });
    expect(invalidated).toMatchObject({ revision: 2, invalidatedAt: '2026-08-30T00:20:00.000Z' });
    expect(await repositories.remoteChatFacts.getCurrentByNaturalKey('bot-remote', 'synthetic-chat', checkedAt)).toBeUndefined();
    repositories.close();
  });

  it('fences facts on credential rotation and rolls all invalidation back on transaction failure', async () => {
    const { repositories } = await setup();
    await repositories.remoteIdentityFacts.upsert(identityInput());
    await repositories.remoteChatFacts.upsert(chatInput());

    await expect(repositories.foundation.transact(transaction => {
      transaction.secretRefs.update('secret-remote', { expectedRevision: 1, referenceKey: 'synthetic/rotated-rollback' });
      throw new Error('rotate fault');
    })).rejects.toThrow('rotate fault');
    expect(await repositories.secretRefs.get('secret-remote')).toMatchObject({ revision: 1 });
    expect(await repositories.remoteIdentityFacts.get('identity-remote')).toMatchObject({ revision: 1, errorCode: undefined });
    expect(await repositories.remoteChatFacts.get('chat-remote')).toMatchObject({ revision: 1, invalidatedAt: undefined });

    await repositories.secretRefs.update('secret-remote', { expectedRevision: 1, referenceKey: 'synthetic/rotated' });
    expect(await repositories.remoteIdentityFacts.get('identity-remote')).toMatchObject({ revision: 2, errorCode: 'REMOTE_CREDENTIAL_ROTATED' });
    expect(await repositories.remoteChatFacts.get('chat-remote')).toMatchObject({ revision: 2, errorCode: 'REMOTE_CREDENTIAL_ROTATED', invalidatedAt: expect.any(String) });
    expect(await repositories.remoteIdentityFacts.getCurrentByChannelBot('bot-remote', checkedAt)).toBeUndefined();
    repositories.close();
  });

  it('rolls identity and chat writes back together on one SQLite connection', async () => {
    const { repositories } = await setup();
    await expect(repositories.remoteFacts.transact(transaction => {
      transaction.remoteIdentityFacts.upsert(identityInput());
      transaction.remoteChatFacts.upsert(chatInput());
      throw new Error('remote fact fault');
    })).rejects.toThrow('remote fact fault');

    expect(await repositories.remoteIdentityFacts.get('identity-remote')).toBeUndefined();
    expect(await repositories.remoteChatFacts.get('chat-remote')).toBeUndefined();
    repositories.close();
  });
});
