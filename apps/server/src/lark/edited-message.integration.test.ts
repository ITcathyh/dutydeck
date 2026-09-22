import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkMessageCoordinator } from './coordinator.js';
import { buildEditedMessageEvent } from './edited-message.js';
import { larkBotsConfigKey, type StoredLarkConfig } from './config.js';
import type { LarkChatMessage } from './service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-edited-message-'));
  const filename = join(directory, 'state.db');
  let repositories = createRepositories(filename);
  const config: StoredLarkConfig = {
    appId: 'cli_edited_inbox', appSecret: 'synthetic', workspace: directory, defaultAgentId: 'codex', permissionMode: 'ask',
    fullTrustConfirmed: true, listening: true, preInjectPrompt: '', groupToolsEnabled: false, groupToolsAllowSend: false,
    pushIntervalMs: 1000, hideTraceOnComplete: false, allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [],
    highRiskAllowedEmails: [], highRiskPattern: 'rm\\b', riskControlMode: 'off'
  };
  await repositories.config.set(larkBotsConfigKey, JSON.stringify([config]));
  const session = { id: 'ses_edited', agentId: 'codex', state: 'idle', cwd: directory, protocol: 'acp', permissionMode: 'ask', createdAt: '', updatedAt: '' };
  const runtime = {
    start: vi.fn(async () => session), getSession: vi.fn(async () => session), subscribe: vi.fn(() => vi.fn()),
    dispatch: vi.fn(async (..._args: unknown[]) => ({ id: 'task_edited', sessionId: session.id, status: 'queued', queuedAhead: 0 })),
    send: vi.fn(), interrupt: vi.fn()
  };
  const createCard = vi.fn(async () => ({ messageId: `om_card_${randomUUID()}` }));
  const service = {
    send: createCard, reply: createCard, update: vi.fn(async () => ({ messageId: 'om_card' })),
    addReaction: vi.fn(async () => ({ reactionId: 'reaction' })), deleteReaction: vi.fn(async () => {}),
    listChatMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    getMessage: vi.fn(async (id: string) => ({ messageId: id, chatId: 'oc_group', messageType: 'text',
      rawContent: '{"text":"reference"}', sender: { type: 'user' }, mentions: [] })),
    getMessageItems: vi.fn(async () => []),
    downloadMessageResource: vi.fn(async () => ({ data: new Uint8Array([65, 66, 67]), contentType: 'text/plain' }))
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const createCoordinator = () => new LarkMessageCoordinator(runtime as any, service as any, log, Math.random, 'ou_bot',
    undefined, undefined, async () => 'topic', undefined, undefined, { store: repositories.config });
  let coordinator = createCoordinator();
  cleanups.push(async () => { coordinator.stop(); repositories.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    config, runtime, service, log,
    get repositories() { return repositories; },
    get coordinator() { return coordinator; },
    restart: () => { coordinator.stop(); repositories.close(); repositories = createRepositories(filename); coordinator = createCoordinator(); },
    inbox: async (id: string) => {
      const raw = await repositories.config.get(`lark.inbox.${config.appId}.${id}`);
      return raw ? JSON.parse(raw) : undefined;
    }
  };
}

async function edited(patch: Partial<LarkChatMessage> = {}) {
  const detail: LarkChatMessage = {
    messageId: `om_edit_${randomUUID()}`, chatId: 'oc_group', messageType: 'text', createTime: '1700000000000',
    rawContent: '{"text":"<p>@_user_1 run once</p>"}',
    sender: { id: 'ou_author', idType: 'open_id', type: 'user' },
    mentions: [{ id: 'ou_bot', idType: 'open_id', key: '@_user_1', name: 'Dutydeck' }],
    deleted: false, updated: true, ...patch
  };
  const event = await buildEditedMessageEvent({ eventMessageId: detail.messageId, detail, botOpenId: 'ou_bot',
    appId: 'cli_edited_inbox', resolveChatType: async () => 'topic' });
  expect(event).toBeDefined();
  return event!;
}

describe('edited-message real coordinator and SQLite inbox', () => {
  it('leaves an unmentioned receive unclaimed, accepts the edit once, and suppresses duplicate update/receive across restart', async () => {
    const h = await harness();
    const event = await edited({ threadId: 'omt_topic', rootId: 'om_root', parentId: 'om_parent' });
    await h.coordinator.handle({ ...event, mentions: [], content: '{"text":"original without mention"}' }, h.config);
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
    expect(await h.inbox(event.messageId)).toBeUndefined();

    await Promise.all([
      h.coordinator.handle(event, h.config),
      h.coordinator.handle(event, h.config),
      h.coordinator.handle({ ...event, content: '{"text":"@_user_1 duplicate receive"}' }, h.config)
    ]);
    await vi.waitFor(async () => expect(await h.inbox(event.messageId)).toMatchObject({ state: 'accepted' }));
    expect(h.runtime.dispatch).toHaveBeenCalledOnce();
    expect(await h.inbox(event.messageId)).toMatchObject({ event: {
      messageId: event.messageId, senderOpenId: 'ou_author', threadId: 'omt_topic', rootId: 'om_root', parentId: 'om_parent'
    } });
    expect(h.runtime.dispatch.mock.calls[0]?.[5]).toBe('ou_author');
    expect(h.service.listChatMessages).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'omt_topic' }));
    expect(h.service.getMessage).toHaveBeenCalledWith('om_parent');

    h.restart();
    await h.coordinator.initializeWorkflows(h.config);
    await Promise.all([h.coordinator.handle(event, h.config), h.coordinator.handle(event, h.config)]);
    expect(h.runtime.dispatch).toHaveBeenCalledOnce();
    expect(await h.inbox(event.messageId)).toMatchObject({ state: 'accepted' });
  });

  it('uses the persisted current access policy after the author loses permission', async () => {
    const h = await harness();
    const event = await edited();
    await h.coordinator.handle({ ...event, mentions: [] }, h.config);
    await h.repositories.config.set(larkBotsConfigKey, JSON.stringify([{ ...h.config, allowedUsers: [{ openId: 'ou_other', name: 'Other' }] }]));
    await h.coordinator.handle(event, h.config);
    await vi.waitFor(() => expect(h.service.reply).toHaveBeenCalledWith(expect.objectContaining({ taskName: '访问被拒绝' })));
    expect(h.runtime.dispatch).not.toHaveBeenCalled();
    expect(h.runtime.start).not.toHaveBeenCalled();
  });

  it.each(['post', 'image', 'file'] as const)('preserves %s resources through conversion and actual local materialization', async messageType => {
    const h = await harness();
    const rawContent = messageType === 'post' ? JSON.stringify({ zh_cn: { title: 'Evidence', content: [[
      { tag: 'at', user_name: 'Dutydeck', user_id: 'ou_bot' }, { tag: 'text', text: ' check <p>literal</p>\nsecond line' },
      { tag: 'img', image_key: 'img_edit' }, { tag: 'file', file_key: 'file_edit', file_name: 'evidence.txt' }
    ]] } }) : messageType === 'image' ? '{"image_key":"img_edit"}' : '{"file_key":"file_edit","file_name":"evidence.txt"}';
    const event = await edited({ messageType, rawContent });
    const resourcesPath = join(tmpdir(), 'dutydeck', 'lark-resources', event.messageId);
    cleanups.push(() => rm(resourcesPath, { recursive: true, force: true }));
    await h.coordinator.handle(event, h.config);
    await vi.waitFor(async () => expect(await h.inbox(event.messageId)).toMatchObject({ state: 'accepted' }));
    expect(h.runtime.dispatch).toHaveBeenCalledOnce();
    const agentPrompt = String(h.runtime.dispatch.mock.calls[0]?.[3]);
    if (messageType !== 'file') expect(h.service.downloadMessageResource).toHaveBeenCalledWith(event.messageId, 'img_edit', 'image');
    if (messageType !== 'image') expect(h.service.downloadMessageResource).toHaveBeenCalledWith(event.messageId, 'file_edit', 'file');
    expect(agentPrompt).toContain(resourcesPath);
    const files = await readdir(resourcesPath);
    expect(files).toHaveLength(messageType === 'post' ? 2 : 1);
    for (const file of files) {
      const path = join(resourcesPath, file);
      expect(agentPrompt).toContain(path);
      expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([65, 66, 67]));
    }
    if (messageType === 'post') {
      expect(agentPrompt).toContain('check <p>literal</p>\nsecond line');
      expect(agentPrompt).toContain('evidence.txt');
    }
  });
});
