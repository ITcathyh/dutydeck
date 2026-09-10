import { describe, expect, it } from 'vitest';
import type { CreateChannelBotInput, CreateSecretRefInput } from '@dutydeck/shared';
import { createRepositories } from './index.js';

function secretInput(id: string): CreateSecretRefInput {
  return { id, kind: 'lark_app_secret', provider: 'keychain', referenceKey: `dutydeck/lark/${id}`, status: 'configured' };
}

function botInput(id: string, credentialRef?: string): CreateChannelBotInput {
  return { id, channel: 'lark', externalAppId: `cli_${id}`, displayName: `Bot ${id}`, brand: 'feishu', credentialRef, state: 'staged' };
}

describe('WP0 foundation repositories', () => {
  it('persists a missing-credential Bot only as staged/disabled and returns a hard blocker', async () => {
    const repositories = createRepositories(':memory:');
    await expect(repositories.secretRefs.create({ ...secretInput('plaintext-rejected'), value: 'plaintext-canary' } as unknown as CreateSecretRefInput)).rejects.toBeDefined();
    expect(await repositories.secretRefs.get('plaintext-rejected')).toBeUndefined();
    const bot = await repositories.channelBots.create(botInput('missing-credential'));

    expect(bot).toMatchObject({ state: 'staged', desiredListenerState: 'disabled', fullTrustConfirmed: false });
    expect(bot.credentialRef).toBeUndefined();
    expect(await repositories.channelBots.readiness(bot.id)).toMatchObject({
      credentialStatus: 'missing',
      listenerEligible: false,
      blockers: [
        { code: 'channel_bot_credential_required' },
        { code: 'channel_bot_activation_unavailable' }
      ]
    });
    const disabled = await repositories.channelBots.update(bot.id, { expectedRevision: 1, state: 'disabled' });
    expect(disabled).toMatchObject({ revision: 2, state: 'disabled', desiredListenerState: 'disabled', fullTrustConfirmed: false });
    await expect(repositories.channelBots.create(botInput('dangling', 'secret-ref-does-not-exist')))
      .rejects.toMatchObject({ code: 'FOUNDATION_SECRET_REF_NOT_FOUND' });
    repositories.close();
  });

  it('commits an atomic cross-repository batch on one connection and rolls every write back on failure', async () => {
    const repositories = createRepositories(':memory:');
    await repositories.foundation.transact(transaction => {
      transaction.secretRefs.create(secretInput('atomic-commit'));
      transaction.channelBots.create(botInput('atomic-commit', 'atomic-commit'));
    });
    expect(await repositories.secretRefs.get('atomic-commit')).toBeDefined();
    expect(await repositories.channelBots.get('atomic-commit')).toBeDefined();
    expect(await repositories.channelBots.readiness('atomic-commit')).toEqual({
      credentialStatus: 'configured',
      listenerEligible: false,
      blockers: [{ code: 'channel_bot_activation_unavailable', message: 'WP0 ChannelBots cannot activate a listener' }]
    });

    await expect(repositories.foundation.transact(transaction => {
      transaction.secretRefs.create(secretInput('atomic-rollback'));
      transaction.channelBots.create(botInput('atomic-rollback', 'atomic-rollback'));
      throw new Error('fault injection');
    })).rejects.toThrow('fault injection');
    expect(await repositories.secretRefs.get('atomic-rollback')).toBeUndefined();
    expect(await repositories.channelBots.get('atomic-rollback')).toBeUndefined();

    await expect(repositories.foundation.transact(async transaction => {
      transaction.secretRefs.create(secretInput('async-rollback'));
      await Promise.resolve();
    })).rejects.toMatchObject({ code: 'FOUNDATION_ASYNC_TRANSACTION_UNSUPPORTED' });
    expect(await repositories.secretRefs.get('async-rollback')).toBeUndefined();
    repositories.close();
  });

  it('enforces optimistic revision and conditionally restores only the current revision', async () => {
    const repositories = createRepositories(':memory:');
    const created = await repositories.secretRefs.create(secretInput('cas'));
    const second = await repositories.secretRefs.update(created.id, { expectedRevision: 1, provider: 'secure-vault' });
    expect(second).toMatchObject({ revision: 2, provider: 'secure-vault', status: 'configured' });
    await expect(repositories.secretRefs.update(created.id, { expectedRevision: 1, status: 'invalid' }))
      .rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });

    const third = await repositories.secretRefs.update(created.id, { expectedRevision: 2, status: 'invalid' });
    await expect(repositories.foundation.rollbackLast('secret_ref', created.id, 2))
      .rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });
    expect(await repositories.foundation.rollbackLast('secret_ref', created.id, third.revision))
      .toEqual({ entityKind: 'secret_ref', entityId: created.id, action: 'restored', revision: 4 });
    expect(await repositories.secretRefs.get(created.id)).toMatchObject({ revision: 4, provider: 'secure-vault', status: 'configured' });
    repositories.close();
  });

  it('refuses to rollback-delete a referenced SecretRef and can rollback unreferenced creates', async () => {
    const repositories = createRepositories(':memory:');
    await repositories.secretRefs.create(secretInput('referenced'));
    await repositories.channelBots.create(botInput('referenced', 'referenced'));

    await expect(repositories.foundation.rollbackLast('secret_ref', 'referenced', 1))
      .rejects.toMatchObject({ code: 'FOUNDATION_ROLLBACK_REFERENCED' });
    expect(await repositories.secretRefs.get('referenced')).toBeDefined();
    expect(await repositories.foundation.rollbackLast('channel_bot', 'referenced', 1))
      .toEqual({ entityKind: 'channel_bot', entityId: 'referenced', action: 'deleted', deletedRevision: 1 });
    expect(await repositories.channelBots.get('referenced')).toBeUndefined();
    expect(await repositories.foundation.rollbackLast('secret_ref', 'referenced', 1))
      .toEqual({ entityKind: 'secret_ref', entityId: 'referenced', action: 'deleted', deletedRevision: 1 });
    expect(await repositories.secretRefs.get('referenced')).toBeUndefined();
    repositories.close();
  });

  it('removes SecretRef metadata with CAS only when no ChannelBot references it', async () => {
    const repositories = createRepositories(':memory:');
    await repositories.secretRefs.create(secretInput('remove-me'));
    await repositories.channelBots.create(botInput('uses-ref', 'remove-me'));
    await expect(repositories.secretRefs.remove('remove-me', 1)).rejects.toMatchObject({ code: 'FOUNDATION_SECRET_REF_REFERENCED' });
    expect(await repositories.secretRefs.get('remove-me')).toBeDefined();
    await repositories.channelBots.update('uses-ref', { expectedRevision: 1, credentialRef: null });
    await expect(repositories.secretRefs.remove('remove-me', 2)).rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });
    expect(await repositories.secretRefs.remove('remove-me', 1)).toMatchObject({ id: 'remove-me', revision: 1 });
    expect(await repositories.secretRefs.get('remove-me')).toBeUndefined();
    repositories.close();
  });
});
