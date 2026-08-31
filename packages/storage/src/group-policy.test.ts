import { describe, expect, it } from 'vitest';
import { REMOTE_FACT_EXPIRED_AT, type CreateRoleAssignmentInput } from '@dockmux/shared';
import { createRepositories } from './index.js';

async function createBot(repositories: ReturnType<typeof createRepositories>, id = 'bot-1') {
  return repositories.channelBots.create({ id, channel: 'lark', externalAppId: `cli_${id}`, displayName: `Bot ${id}`, brand: 'feishu', state: 'disabled' });
}

describe('WP1a group policy repositories', () => {
  it('creates policies and bindings with safe defaults and enforces CAS', async () => {
    const repositories = createRepositories(':memory:');
    await createBot(repositories);
    const policy = await repositories.channelBotPolicies.create({
      id: 'policy-1', channelBotId: 'bot-1', defaults: {}, routingDefaults: { groupReplyMode: 'chat', mentionPolicy: 'always' },
      accessPolicy: { mode: 'owner_only', principalIds: [] },
      groupToolsPolicy: { readCeiling: false, discoverCeiling: false, sendCeiling: false, readDefault: false, discoverDefault: false, sendDefault: false }
    });
    const binding = await repositories.groupBindings.create({ id: 'binding-1', channelBotId: 'bot-1', externalChatId: 'chat-1' });

    expect(policy).toMatchObject({ revision: 1, channelBotId: 'bot-1' });
    expect(binding).toMatchObject({ revision: 1, state: 'staged', oncall: false, routingOverride: { groupReplyMode: { mode: 'inherit' }, mentionPolicy: { mode: 'inherit' } }, groupToolsOverride: { read: 'inherit', discover: 'inherit', send: 'inherit' } });
    const updated = await repositories.groupBindings.update(binding.id, { expectedRevision: 1, state: 'disabled', oncall: true, routingOverride: { groupReplyMode: { mode: 'set', value: 'chat-topic' }, mentionPolicy: { mode: 'set', value: 'topic' } } });
    expect(updated).toMatchObject({ revision: 2, state: 'disabled', oncall: true });
    await expect(repositories.groupBindings.update(binding.id, { expectedRevision: 1, oncall: false })).rejects.toMatchObject({ code: 'FOUNDATION_REVISION_CONFLICT' });
    repositories.close();
  });

  it('keeps RemoteChatFact revision independent from GroupBinding policy revision', async () => {
    const repositories = createRepositories(':memory:');
    await createBot(repositories);
    const binding = await repositories.groupBindings.create({ id: 'binding-fact', channelBotId: 'bot-1', externalChatId: 'chat-fact' });
    const fact = await repositories.remoteChatFacts.create({ id: 'fact-1', channelBotId: 'bot-1', externalChatId: 'chat-fact', membershipState: 'unknown', chatType: 'unknown', observedAt: '2026-08-30T00:00:00.000Z' });
    await repositories.remoteChatFacts.update(fact.id, { expectedRevision: 1, membershipState: 'member', chatType: 'topic_group', displayName: 'Synthetic group', lastSuccessAt: '2026-08-30T00:01:00.000Z' });

    expect(await repositories.remoteChatFacts.get(fact.id)).toMatchObject({ revision: 2, membershipState: 'member', expiresAt: REMOTE_FACT_EXPIRED_AT });
    expect(await repositories.remoteChatFacts.getCurrentByNaturalKey('bot-1', 'chat-fact', '2026-08-30T00:02:00.000Z')).toBeUndefined();
    expect(await repositories.groupBindings.get(binding.id)).toMatchObject({ revision: 1, state: 'staged' });
    repositories.close();
  });

  it('stores only opaque principals and keeps action gates independent from roles', async () => {
    const repositories = createRepositories(':memory:');
    await createBot(repositories);
    const binding = await repositories.groupBindings.create({ id: 'binding-role', channelBotId: 'bot-1', externalChatId: 'chat-role' });
    const role = await repositories.roleAssignments.create({
      id: 'role-1', channelBotId: 'bot-1', groupBindingId: binding.id, principalId: 'principal_alice',
      role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false }
    });
    expect(role).toMatchObject({ role: 'can_operate', operateScope: 'group_runs', actionGates: { terminalWrite: false, highRisk: true, groupToolsSend: false }, state: 'active' });
    await expect(repositories.roleAssignments.create({
      id: 'raw-pii', channelBotId: 'bot-1', principalId: 'alice@example.com', role: 'can_talk', operateScope: 'none'
    } as unknown as CreateRoleAssignmentInput)).rejects.toBeDefined();
    expect(await repositories.roleAssignments.get('raw-pii')).toBeUndefined();
    await expect(repositories.roleAssignments.create({ id: 'bad-admin-scope', channelBotId: 'bot-1', principalId: 'principal_admin', role: 'admin', operateScope: 'bot_runs' })).rejects.toBeDefined();
    repositories.close();
  });

  it('rolls policy, binding, fact and role writes back as one same-connection transaction', async () => {
    const repositories = createRepositories(':memory:');
    await createBot(repositories);
    await expect(repositories.groupPolicy.transact(transaction => {
      transaction.channelBotPolicies.create({
        id: 'policy-atomic', channelBotId: 'bot-1', defaults: {}, routingDefaults: { groupReplyMode: 'chat', mentionPolicy: 'always' },
        accessPolicy: { mode: 'owner_only', principalIds: [] },
        groupToolsPolicy: { readCeiling: false, discoverCeiling: false, sendCeiling: false, readDefault: false, discoverDefault: false, sendDefault: false }
      });
      transaction.groupBindings.create({ id: 'binding-atomic', channelBotId: 'bot-1', externalChatId: 'chat-atomic' });
      transaction.remoteChatFacts.create({ id: 'fact-atomic', channelBotId: 'bot-1', externalChatId: 'chat-atomic', membershipState: 'member', chatType: 'group', observedAt: '2026-08-30T00:00:00.000Z' });
      transaction.roleAssignments.create({ id: 'role-atomic', channelBotId: 'bot-1', groupBindingId: 'binding-atomic', principalId: 'principal_atomic', role: 'can_talk', operateScope: 'none' });
      throw new Error('fault after all WP1a entities');
    })).rejects.toThrow('fault after all WP1a entities');

    expect(await repositories.channelBotPolicies.get('policy-atomic')).toBeUndefined();
    expect(await repositories.groupBindings.get('binding-atomic')).toBeUndefined();
    expect(await repositories.remoteChatFacts.get('fact-atomic')).toBeUndefined();
    expect(await repositories.roleAssignments.get('role-atomic')).toBeUndefined();
    repositories.close();
  });
});
