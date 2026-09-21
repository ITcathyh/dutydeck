import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { CollaborationScope } from '@dutydeck/shared';
import { LarkTeamContextReader } from './team-context.js';
import type { StoredLarkConfig } from './config.js';
import type { LarkChat, LarkChatMessage, LarkChatsResult } from './service.js';

const origin = { appId: 'cli_one', chatId: 'oc_origin' }, source = { appId: 'cli_one', chatId: 'oc_todo' };
const at = '2026-09-21T03:00:00.000Z';
const repositories: ReturnType<typeof createRepositories>[] = [];
afterEach(() => { for (const repo of repositories.splice(0)) repo.close(); });
const chat = (chatId: string, name = chatId): LarkChat => ({ chatId, name, external: false });
const message = (messageId: string, chatId = source.chatId, text = '个人待办真实进展'): LarkChatMessage => ({
  messageId, chatId, createTime: String(Date.parse(at)), messageType: 'text', rawContent: JSON.stringify({ text }),
  sender: { id: 'ou_person', type: 'user' }, mentions: [], deleted: false, updated: false
});

function setup(chats = [chat(origin.chatId), chat(source.chatId, '个人待办')]) {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  const config = { appId: origin.appId, appSecret: 'synthetic', listening: true, groupToolsEnabled: true, fullTrustConfirmed: true, memoryEnabled: false } as StoredLarkConfig;
  const listChats = vi.fn(async (_token?: string): Promise<LarkChatsResult> => ({ items: chats, hasMore: false }));
  const listChatMessages = vi.fn(async (_input: unknown) => ({ items: [] as LarkChatMessage[], hasMore: false }));
  const canRead = vi.fn(async (_scope: CollaborationScope) => true), readMemory = vi.fn(async () => '个人待办记忆');
  const readConfig = vi.fn(async () => config);
  const reader = new LarkTeamContextReader({ repository: repos.collaboration, readConfig,
    serviceFor: () => ({ listChats, listChatMessages }), canRead, readMemory, now: () => new Date(at) });
  const observe = (scope = source, eventId = 'om_old', text = '个人待办部署完成') => repos.collaboration.observe({ scope,
    source: 'lark.message', eventId, messageId: eventId, occurredAt: at, receivedAt: at, senderKind: 'human', senderId: 'ou_person',
    text, origin: 'live', refs: [eventId], missing: [] });
  return { repos, config, reader, listChats, listChatMessages, canRead, readMemory, readConfig, observe };
}

describe('host team context reader', () => {
  it('prioritizes a named group and reads beyond the recent 30 observations without writes or participation', async () => {
    const f = setup([chat(origin.chatId), ...Array.from({ length: 9 }, (_, i) => chat(`oc_${i}`, `项目${i}`)), chat(source.chatId, '个人待办')]);
    await f.observe();
    for (let i = 0; i < 120; i++) await f.observe(source, `om_new_${i}`, '普通交流');
    const observe = vi.spyOn(f.repos.collaboration, 'observe'), settings = vi.spyOn(f.repos.collaboration, 'updateSettings');
    const list = vi.spyOn(f.repos.collaboration, 'listObservations');
    const result = await f.reader.read(origin, '看看我的个人待办');
    expect(result.sources).toHaveLength(8);
    expect(result.sources[0]).toMatchObject({ scope: source, name: '个人待办', status: 'partial', missing: expect.arrayContaining(['team_source_limit_reached']) });
    expect(result.observations.find(item => item.messageId === 'om_old')).toMatchObject({ scope: source, origin: 'history', senderId: 'ou_person', occurredAt: at });
    expect(list).toHaveBeenCalledWith(source, { afterSequence: 100, limit: 100 });
    expect(result.observations).toHaveLength(80);
    expect(observe).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
    expect(await f.repos.groupBindings.listByChannelBot('cli_one')).toEqual([]);
    expect(f.readMemory).not.toHaveBeenCalled();
  });

  it('deduplicates live API messages over cache and exposes followups and enabled memory as external evidence', async () => {
    const f = setup(); f.config.memoryEnabled = true;
    await f.observe();
    const followup = await f.repos.collaboration.createFollowup({ scope: source, goal: '个人待办发布', createdBy: 'ou_person' });
    f.listChatMessages.mockResolvedValue({ items: [message('om_old')], hasMore: true });
    const result = await f.reader.read(origin, '个人待办');
    expect(result.observations.filter(item => item.messageId === 'om_old')).toHaveLength(1);
    expect(result.observations.find(item => item.messageId === 'om_old')?.text).toBe('个人待办真实进展');
    expect(result.observations.find(item => item.source === 'lark.team.followup')).toMatchObject({ scope: source, origin: 'external', refs: expect.arrayContaining([followup.id]) });
    expect(JSON.parse(result.observations.find(item => item.source === 'lark.team.followup')!.text)).toMatchObject({
      createdBy: 'ou_person', updatedBy: 'ou_person', createdAt: followup.createdAt, updatedAt: followup.updatedAt
    });
    expect(followup.ownerId).toBeUndefined();
    expect(result.observations.find(item => item.source === 'lark.team.memory')).toMatchObject({ scope: source, origin: 'external' });
    expect(result.sources[0]).toMatchObject({ status: 'partial', missing: ['recent_history_partial'] });
  });

  it('rejects denied groups, departed groups and other apps before loading their cached content', async () => {
    const f = setup();
    await f.observe(); await f.observe({ appId: 'cli_two', chatId: 'oc_other' }, 'om_other', 'secret');
    await f.observe({ ...source, chatId: 'oc_departed' }, 'om_departed', 'secret');
    f.canRead.mockResolvedValue(false);
    const list = vi.spyOn(f.repos.collaboration, 'listObservations');
    const result = await f.reader.read(origin, '看看我的个人待办');
    expect(result.observations).toEqual([]);
    expect(result.sources).toEqual([{ scope: source, name: '个人待办', status: 'unavailable', missing: ['context_read_denied'] }]);
    expect(list).not.toHaveBeenCalled(); expect(f.listChatMessages).not.toHaveBeenCalled();
  });

  it('drops cached observations on a platform 403 and records unavailable rather than an empty group', async () => {
    const f = setup(); await f.observe();
    f.listChatMessages.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    const result = await f.reader.read(origin, '个人待办');
    expect(result.observations).toEqual([]);
    expect(result.sources[0]).toMatchObject({ status: 'unavailable', missing: ['message_read_unavailable'] });
  });

  it.each([undefined, 'repeat'])('rejects incomplete group pagination with token %s', async token => {
    const f = setup(); f.listChats.mockResolvedValue({ items: [chat(source.chatId)], hasMore: true, pageToken: token });
    await expect(f.reader.read(origin, '个人待办')).rejects.toMatchObject({ code: 'TEAM_CONTEXT_PAGINATION_INCOMPLETE' });
    expect(f.listChatMessages).not.toHaveBeenCalled();
  });

  it('follows current group pagination and excludes mismatching message scope and p2p entries', async () => {
    const f = setup();
    f.listChats.mockResolvedValueOnce({ items: [chat(origin.chatId), { ...chat('oc_p2p'), chatMode: 'p2p' }], hasMore: true, pageToken: 'next' })
      .mockResolvedValueOnce({ items: [chat(source.chatId, '个人待办')], hasMore: false });
    f.listChatMessages.mockResolvedValue({ items: [message('om_ok'), message('om_bad', 'oc_other')], hasMore: false });
    const result = await f.reader.read(origin, '个人待办');
    expect(f.listChats).toHaveBeenNthCalledWith(2, 'next');
    expect(result.sources).toHaveLength(1);
    expect(result.observations.map(item => item.messageId)).toEqual(['om_ok']);
    expect(result.sources[0]?.missing).toEqual(['message_scope_mismatch']);
  });

  it('rechecks current membership and read policy before delivery without replacing frozen material', async () => {
    const f = setup(); await f.observe();
    const result = await f.reader.read(origin, '个人待办');
    const frozen = JSON.stringify(result);
    expect(await f.reader.authorize(origin, result)).toBe(true);
    expect(f.listChatMessages).toHaveBeenLastCalledWith({ chatId: source.chatId, pageSize: 1, order: 'desc' });
    expect(JSON.stringify(result)).toBe(frozen);
    f.canRead.mockResolvedValue(false);
    expect(await f.reader.authorize(origin, result)).toBe(false);
    f.canRead.mockResolvedValue(true); f.listChats.mockResolvedValue({ items: [], hasMore: false });
    expect(await f.reader.authorize(origin, result)).toBe(false);
    expect(f.listChatMessages).toHaveBeenCalledTimes(2);
  });

  it('rejects a platform read revocation even while the Bot remains a member and local policy allows reading', async () => {
    const f = setup(); await f.observe();
    const result = await f.reader.read(origin, '个人待办');
    const frozen = JSON.stringify(result);
    f.listChatMessages.mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    expect(await f.reader.authorize(origin, result)).toBe(false);
    expect(f.listChats).toHaveBeenCalledTimes(2);
    expect(await f.canRead.mock.results.at(-1)!.value).toBe(true);
    expect(JSON.stringify(result)).toBe(frozen);
  });

  it('does not resurrect stored memory while memory is disabled and rejects changed Bot identity', async () => {
    const f = setup();
    await f.repos.collaboration.observe({ scope: source, source: 'lark.memory', eventId: 'memory', occurredAt: at, receivedAt: at,
      senderKind: 'system', text: 'old memory', origin: 'history', refs: [], missing: [] });
    expect((await f.reader.read(origin, '个人待办')).observations).toEqual([]);
    f.config.appId = 'cli_other';
    expect((await f.reader.read(origin, '个人待办')).sources).toEqual([]);
    expect(f.listChats).toHaveBeenCalledTimes(1);
  });

  it('honors default-on memory and checks empty-context metadata without refetching group membership', async () => {
    const f = setup(); delete f.config.memoryEnabled;
    const result = await f.reader.read(origin, '个人待办');
    expect(result.observations.find(item => item.source === 'lark.team.memory')?.origin).toBe('external');
    const empty = { ...result, observations: [] };
    expect(await f.reader.authorize(origin, empty)).toBe(true);
    expect(f.listChats).toHaveBeenCalledTimes(1);
    expect(await f.reader.authorize(origin, { ...empty, sources: [{ ...result.sources[0]!, scope: origin }] })).toBe(false);
    expect(await f.reader.authorize(origin, { ...empty, sources: [{ ...result.sources[0]!, scope: { appId: 'cli_other', chatId: source.chatId } }] })).toBe(false);
  });
});
