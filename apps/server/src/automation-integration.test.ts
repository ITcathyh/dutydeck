import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { installationOwnerTaskActor, type RepositoryBundle } from '@dutydeck/shared';
import { createAutomationIntegration } from './automation-integration.js';

const opened: RepositoryBundle[] = [];
afterEach(() => { for (const repo of opened.splice(0)) repo.close(); });

async function fixture() {
  const repos = createRepositories(':memory:'); opened.push(repos);
  const session = { id: 's1', agentId: 'a', source: 'lark', sourceId: 'cli_a:oc_chat:group:thread:om_root', cwd: '/project', state: 'completed', runId: 'r', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let bot = { appId: 'cli_a', appSecret: 'secret-canary', listening: true, fullTrustConfirmed: true, allowedUsers: [{ openId: 'ou_alice', name: 'Alice' }], allowedEmails: [] };
  const setBot = async (patch: object) => { bot = { ...bot, ...patch }; await repos.config.set('lark.bots', JSON.stringify([bot])); };
  await setBot({});
  const groups = { authorize: vi.fn(async () => undefined), beginTurn: vi.fn() };
  const client = { getUserEmails: vi.fn(async () => []), reply: vi.fn(async () => ({ messageId: 'om_result' })), send: vi.fn(async () => ({ messageId: 'om_result' })) };
  const runtime = { getSession: vi.fn(async () => session), getEvents: vi.fn(async () => []) };
  const integration = createAutomationIntegration(repos, runtime as any, groups as any, { client: () => client as any, log: { warn: vi.fn() } });
  return { repos, session, setBot, groups, client, runtime, ...integration };
}

describe('automation service integration', () => {
  it('checks the captured actor without changing a running turn identity, and rechecks revocation', async () => {
    const f = await fixture();
    expect(await f.authorize('s1', 'ou_alice')).toBe(true);
    expect(await f.authorize('s1', 'ou_bob')).toBe(false);
    expect(f.groups.beginTurn).not.toHaveBeenCalled();
    await f.setBot({ allowedUsers: [{ openId: 'ou_bob', name: 'Bob' }] });
    expect(await f.authorize('s1', 'ou_alice')).toBe(false);
    await f.setBot({ listening: false });
    expect(await f.authorize('s1', installationOwnerTaskActor)).toBe(false);
  });

  it('requires a known actor for local sessions and keeps foundation bindings disabled', async () => {
    const f = await fixture();
    f.session.source = 'web';
    expect(await f.authorize('s1')).toBe(false);
    expect(await f.authorize('s1', 'ou_alice')).toBe(false);
    expect(await f.authorize('s1', installationOwnerTaskActor)).toBe(true);
    f.session.source = 'foundation_group_binding';
    expect(await f.authorize('s1', installationOwnerTaskActor)).toBe(false);
  });

  it.each(['completed', 'failed', 'interrupted'] as const)('delivers %s for only the requested turn and pins the recipient across retries', async status => {
    const f = await fixture();
    const timestamp = new Date().toISOString();
    await f.repos.tasks.save({ id: 't1', sessionId: 's1', prompt: 'target', status, createdAt: timestamp, updatedAt: timestamp, executionContext: { agentPrompt: 'target', actorId: 'ou_alice' } });
    const mapping = (id: string, reply: string) => ({ id, channel: 'lark-card:cli_a', externalId: id, sessionId: 's1', createdAt: timestamp, extra: JSON.stringify({ app_id: 'cli_a', chat_id: 'oc_chat', reply_message_id: reply, reply_in_thread: true }) });
    await f.repos.channelMappings.save(mapping('original', 'om_original'));
    await f.repos.channelMappings.save({ ...mapping('old_inserted_last', 'om_old'), createdAt: '2000-01-01T00:00:00.000Z' });
    f.runtime.getEvents.mockResolvedValue([
      { type: 'text', data: { text: 'previous secret', role: 'assistant' } },
      { type: 'text', data: { text: 'target', role: 'user', taskId: 't1' } },
      { type: 'text', data: { text: 'target result', role: 'assistant' } },
      { type: 'text', data: { text: 'next', role: 'user', taskId: 't2' } },
      { type: 'text', data: { text: 'next result', role: 'assistant' } }
    ] as any);
    await f.prepareDelivery('s1', 'automation1');
    await f.repos.channelMappings.save(mapping('later', 'om_later'));
    await f.deliver('s1', 't1', 'occ1', 'automation1');
    await f.deliver('s1', 't1', 'occ1', 'automation1');
    const first = f.client.reply.mock.calls[0]![0] as any;
    const second = f.client.reply.mock.calls[1]![0] as any;
    expect(first.messageId).toBe('om_original'); expect(second.messageId).toBe('om_original');
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.state).toBe(status);
    expect(JSON.stringify(first)).toContain('target result');
    expect(JSON.stringify(first)).not.toContain('previous secret'); expect(JSON.stringify(first)).not.toContain('next result');
    expect(JSON.stringify(first)).not.toContain('secret-canary');
    await f.setBot({ listening: false });
    await expect(f.deliver('s1', 't1', 'occ1', 'automation1')).rejects.toThrow('权限');
    expect(f.client.reply).toHaveBeenCalledTimes(2);
  });
});
