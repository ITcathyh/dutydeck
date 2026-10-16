import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { Session } from '@dutydeck/shared';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../app.js';
import { signSessionShareToken } from '../auth/auth.js';
import { __testOnly_resetLarkGate } from './api-gate.js';
import { larkBotsConfigKey } from './config.js';
import { createLarkSessionSourceResolver } from './session-source.js';
import type { LarkCardService, LarkChatMessage } from './service.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); __testOnly_resetLarkGate(); vi.useRealTimers(); });
const session: Session = { id: 'ses_source', agentId: 'test', state: 'idle', cwd: '/tmp/test', runId: 'run_test',
  source: 'lark', sourceId: 'cli_test:oc_group:group:user:ou_first', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
const message = (changes: Partial<LarkChatMessage> = {}): LarkChatMessage => ({ messageId: 'om_first', chatId: 'oc_group',
  sender: { id: 'ou_first', idType: 'open_id', type: 'user', name: '小李' }, threadId: 'omt_origin',
  messageType: 'text', rawContent: '{"text":"hello"}', createTime: '0', mentions: [], deleted: false, updated: false, ...changes });

function fixture() {
  const repos = createRepositories(':memory:');
  cleanup.push(() => repos.close());
  const client = {
    getChatPreflightInfo: vi.fn(async () => ({ name: '项目讨论' })),
    getContactUser: vi.fn(async () => ({ openId: 'ou_first', name: '小李' })),
    getMessage: vi.fn(async () => message())
  };
  const options = { cardMappings: repos.channelMappings, config: repos.config, service: client as unknown as LarkCardService };
  const mapping = async (externalId: string, changes: Record<string, unknown> = {}, at = '2026-10-01T00:00:01Z', sessionId = session.id, appId = 'cli_test') => {
    const channel = `lark-card:${appId}`;
    await repos.channelMappings.save({ id: `${channel}:${externalId}`, channel, externalId, sessionId, createdAt: at,
      extra: JSON.stringify({ app_id: appId, chat_id: 'oc_group', sender_open_id: 'ou_first', sender_type: 'user',
        thread_id: 'omt_origin', reply_message_id: externalId, started_at: Date.parse(at), ...changes }) });
  };
  return { repos, client, options, mapping, resolve: createLarkSessionSourceResolver(options) };
}

describe('session source', () => {
  it('uses the first persisted origin and matches app, chat and session rather than the latest follow-up actor', async () => {
    const f = fixture();
    await f.mapping('om_other_app', {}, '2026-09-01T00:00:00Z', session.id, 'cli_other');
    await f.mapping('om_wrong_app', { app_id: 'cli_other' }, '2026-09-01T00:00:00Z');
    await f.mapping('om_other_chat', { chat_id: 'oc_other' }, '2026-09-01T00:00:00Z');
    await f.mapping('om_other_session', {}, '2026-09-01T00:00:00Z', 'ses_other');
    await f.mapping('om_followup', { sender_open_id: 'ou_later', thread_id: 'omt_later' }, '2026-10-01T00:00:02Z');
    await f.mapping('om_first');
    const result = await f.resolve(session);
    expect(result).toMatchObject({ originAvailable: true, chat: { id: 'oc_group', name: '项目讨论', type: 'group' },
      topic: { id: 'omt_origin' }, initiator: { id: 'ou_first', name: '小李', type: 'user' } });
    expect(result?.topic?.url).toContain('open_thread_id=omt_origin');
    expect(f.client.getMessage).toHaveBeenCalledWith('om_first');
    expect(f.client.getContactUser).toHaveBeenCalledWith('ou_first', 'open_id');
    await f.resolve(session);
    expect(f.client.getMessage).toHaveBeenCalledOnce();
  });

  it('recovers the original topic from the origin message, never from a user scope or an unrelated chat', async () => {
    const f = fixture();
    await f.mapping('om_first', { thread_id: undefined, root_message_id: 'omt_legacy_bad_root' });
    expect((await f.resolve(session))?.topic?.id).toBe('omt_origin');
    f.client.getMessage.mockResolvedValue(message({ chatId: 'oc_other', sender: { id: 'ou_first', type: 'user', name: '错误名字' }, threadId: 'omt_other' }));
    const result = await createLarkSessionSourceResolver(f.options)(session);
    expect(result?.topic).toBeUndefined();
    expect(result?.initiator?.name).toBe('小李');
  });

  it('keeps bots distinct and does not resolve them as contact users', async () => {
    const f = fixture();
    await f.mapping('om_first', { sender_type: 'bot', sender_open_id: 'ou_bot' });
    f.client.getMessage.mockResolvedValue(message({ sender: { id: 'ou_bot', idType: 'open_id', type: 'bot', name: '告警助手' } }));
    expect((await f.resolve(session))?.initiator).toEqual({ id: 'ou_bot', name: '告警助手', type: 'bot' });
    expect(f.client.getContactUser).not.toHaveBeenCalled();
  });

  it('retains IDs and the saved topic when platform lookups fail', async () => {
    const f = fixture();
    await f.mapping('om_first');
    for (const method of Object.values(f.client)) method.mockRejectedValue(new Error('permission denied'));
    expect(await f.resolve(session)).toMatchObject({ chat: { id: 'oc_group', name: 'oc_group' }, topic: { id: 'omt_origin' }, initiator: { id: 'ou_first', name: 'ou_first' } });
  });

  it.each(['user', 'app'] as const)('recovers the original %s sender after another person retries the persisted task', async senderType => {
    const f = fixture();
    await f.mapping('om_first', { turn: 2, sender_open_id: 'ou_retry_operator', sender_type: 'user', reply_message_id: 'om_later_reply' });
    f.client.getMessage.mockResolvedValue(message({ sender: { id: 'ou_first', idType: 'open_id', type: senderType, name: '最初发起人' } }));
    const result = await f.resolve({ ...session, sourceId: 'cli_test:oc_group:group:thread:om_root' });
    expect(result?.initiator).toEqual({ id: 'ou_first', name: senderType === 'app' ? '最初发起人' : '小李', type: senderType === 'app' ? 'bot' : 'user' });
    expect(f.client.getMessage).toHaveBeenCalledWith('om_first');
    if (senderType === 'app') expect(f.client.getContactUser).not.toHaveBeenCalled();
    else expect(f.client.getContactUser).toHaveBeenCalledWith('ou_first', 'open_id');
  });

  it('uses stable user scope after retry when the original message is unavailable, without assigning the retry operator type', async () => {
    const f = fixture();
    await f.mapping('om_first', { turn: 2, sender_open_id: 'ou_retry_operator', sender_type: 'user' });
    f.client.getMessage.mockRejectedValue(new Error('deleted'));
    expect((await f.resolve(session))?.initiator).toEqual({ id: 'ou_first', name: 'ou_first' });
    expect(f.client.getContactUser).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    message({ chatId: 'oc_other' }),
    message({ messageId: 'om_other' }),
    message({ sender: { id: 'on_union', idType: 'union_id', type: 'user', name: '错误发起人' } }),
    message({ sender: { id: 'ou_wrong_type', idType: 'union_id', type: 'user', name: '错误发起人' } })
  ])('leaves an unconfirmed retried origin unavailable when the original message is absent or mismatched (%#)', async originalMessage => {
    const f = fixture();
    await f.mapping('om_first', { turn: 2, sender_open_id: 'ou_retry_operator', sender_type: 'user' });
    if (originalMessage) f.client.getMessage.mockResolvedValue(originalMessage);
    else f.client.getMessage.mockRejectedValue(new Error('deleted'));
    const result = await f.resolve({ ...session, sourceId: 'cli_test:oc_group:group:thread:om_root' });
    expect(result?.initiator).toBeUndefined();
    expect(f.client.getContactUser).not.toHaveBeenCalled();
  });

  it('does not promote a later follow-up after a broken earliest origin', async () => {
    const f = fixture();
    await f.repos.channelMappings.save({ id: 'lark-card:cli_test:om_broken', channel: 'lark-card:cli_test', externalId: 'om_broken',
      sessionId: session.id, createdAt: '2026-09-01T00:00:00Z', extra: 'broken-json' });
    await f.mapping('om_followup', { sender_open_id: 'ou_later', thread_id: 'omt_later' });
    const result = await f.resolve({ ...session, sourceId: 'cli_test:oc_group:group:thread:om_root' });
    expect(result).toMatchObject({ originAvailable: false, chat: { name: '项目讨论' } });
    expect(result?.initiator).toBeUndefined();
    expect(result?.topic).toBeUndefined();
    expect(f.client.getMessage).not.toHaveBeenCalled();
    expect(f.client.getContactUser).not.toHaveBeenCalled();
  });

  it('preserves the original sender and chat name when the contact lookup exceeds the total budget', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.mapping('om_first', { turn: 2, sender_open_id: 'ou_retry_operator' });
    f.client.getContactUser.mockImplementation(() => new Promise(() => {}));
    const pending = f.resolve({ ...session, sourceId: 'cli_test:oc_group:group:thread:om_root' });
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await pending).toMatchObject({ chat: { name: '项目讨论' }, initiator: { id: 'ou_first', name: '小李', type: 'user' } });
  });

  it('bounds optional platform reads and retries after cached fallback expiry', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.mapping('om_first');
    f.client.getMessage.mockImplementation(() => new Promise(() => {}));
    const pending = f.resolve(session);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await pending).toMatchObject({ topic: { id: 'omt_origin' }, initiator: { name: 'ou_first' } });
    f.client.getMessage.mockRejectedValue(new Error('missing'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await f.resolve(session))?.initiator?.name).toBe('小李');
  });

  it('handles old, malformed, missing and non-Lark origins without inventing a topic', async () => {
    const f = fixture();
    await f.repos.channelMappings.save({ id: 'bad', channel: 'lark-card:cli_test', externalId: 'bad', sessionId: session.id, createdAt: session.createdAt, extra: 'broken-json' });
    const result = await f.resolve(session);
    expect(result).toMatchObject({ originAvailable: false, initiator: { id: 'ou_first' } });
    expect(result?.topic).toBeUndefined();
    expect(f.client.getMessage).not.toHaveBeenCalled();
    expect(await f.resolve({ ...session, source: 'web' })).toBeUndefined();
    expect(await f.resolve({ ...session, sourceId: 'invalid' })).toBeUndefined();
    const oldThread = await f.resolve({ ...session, id: 'ses_old', sourceId: 'cli_test:oc_group:group:thread:om_old_root' });
    expect(oldThread?.topic).toBeUndefined();
  });

  it('describes ordinary private chats without labelling them as topics or looking up a group name', async () => {
    const f = fixture();
    await f.mapping('om_first', { thread_id: undefined, chat_type: 'p2p' });
    f.client.getMessage.mockRejectedValue(new Error('old message unavailable'));
    expect(await f.resolve({ ...session, sourceId: 'cli_test:oc_group:p2p' })).toMatchObject({ originAvailable: true, chat: { name: '私聊', type: 'p2p' }, initiator: { name: '小李' } });
    expect(f.client.getChatPreflightInfo).not.toHaveBeenCalled();
  });
});

describe('source metadata through the existing shared session API', () => {
  it('resolves names through the real Lark service and keeps share and execution authorization intact', async () => {
    const f = fixture();
    await f.mapping('om_first');
    await f.repos.sessions.save(session);
    await f.repos.config.set(larkBotsConfigKey, JSON.stringify([{ appId: 'cli_test', appSecret: 'synthetic', brand: 'lark', riskControlMode: 'off' }]));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const data = url.includes('/chats/') ? { name: '项目讨论' }
        : url.includes('/contact/') ? { user: { open_id: 'ou_first', name: '小李' } }
        : { items: [{ message_id: 'om_first', chat_id: 'oc_group', thread_id: 'omt_origin', msg_type: 'text', sender: { id: 'ou_first' }, body: { content: '{"text":"hello"}' } }] };
      return new Response(JSON.stringify(url.includes('/auth/') ? { code: 0, tenant_access_token: 'synthetic', expire: 7200 } : { code: 0, data }));
    });
    let allowed = true;
    const getSession = vi.fn((id: string) => f.repos.sessions.get(id));
    const app = await buildApp({ getSession } as any, {
      lark: { cardMappings: f.repos.channelMappings, config: f.repos.config, listeningDisabled: true, fetcher, env: { LARK_API_QPS: '1000' } },
      auth: { mode: 'token', getToken: async () => 'admin', getShareSecret: async () => 'share-secret' },
      executionPolicy: { authorize: async () => ({ allowed, code: 'DENIED', reason: 'denied' }) as any }
    });
    cleanup.push(() => app.close());
    const url = `/api/sessions/${session.id}?share=${signSessionShareToken('share-secret', session.id)}`;
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(200);
    expect(response.json().sourceContext).toMatchObject({ chat: { name: '项目讨论' }, initiator: { name: '小李' } });
    expect(response.json().sourceContext.topic.url).toContain('applink.larksuite.com');
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('https://open.larksuite.com/'))).toBe(true);
    getSession.mockClear(); fetcher.mockClear();
    expect((await app.inject({ url: `/api/sessions/${session.id}?share=forged` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/sessions/ses_other?share=${signSessionShareToken('share-secret', session.id)}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/send?share=${signSessionShareToken('share-secret', session.id)}`, payload: { prompt: 'write' } })).statusCode).toBe(401);
    allowed = false;
    expect((await app.inject({ url })).statusCode).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns the owning instance source metadata through the existing share proxy', async () => {
    const f = fixture();
    await f.mapping('om_first');
    const peer = await buildApp({ getSession: async () => session } as any, {
      lark: { ...f.options, listeningDisabled: true },
      auth: { mode: 'token', getToken: async () => 'peer-admin', getShareSecret: async () => 'peer-secret' }
    });
    await peer.listen({ host: '127.0.0.1', port: 0 }); cleanup.push(() => peer.close());
    const localRead = vi.fn();
    const main = await buildApp({ getSession: localRead } as any, { instances: [{ id: 'peer', name: 'Peer', url: `http://127.0.0.1:${(peer.server.address() as AddressInfo).port}` }],
      auth: { mode: 'token', getToken: async () => 'admin', getShareSecret: async () => 'main-secret' } });
    cleanup.push(() => main.close());
    const response = await main.inject({ url: `/api/instances/peer/sessions/${session.id}?share=${signSessionShareToken('peer-secret', session.id)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().sourceContext).toMatchObject({ topic: { id: 'omt_origin' }, initiator: { name: '小李' } });
    expect(localRead).not.toHaveBeenCalled();
  });
});
