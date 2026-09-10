import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkMessageCoordinator } from './coordinator.js';
import { LarkTaskInbox } from './task-inbox.js';
import type { LarkMessageEvent } from './listener.js';

const message = (overrides: Partial<LarkMessageEvent> = {}): LarkMessageEvent => ({
  messageId: 'om_original',
  chatId: 'oc_chat',
  chatType: 'group',
  messageType: 'text',
  content: '{"text":"原始请求"}',
  mentions: [],
  ...overrides
});

const openDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-lark-inbox-'));
  const filename = join(directory, 'state.db');
  return { directory, filename, repositories: createRepositories(filename) };
};

describe('persistent Lark task inbox', () => {
  it('claims a same-app message once even under concurrent claims, while apps stay isolated', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const inbox = new LarkTaskInbox(repositories.config);
      const event = message();
      const claims = await Promise.all([
        inbox.claim('app_one', event),
        inbox.claim('app_one', event)
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await repositories.config.list!('lark.inbox.app_one.')).toHaveLength(1);

      const isolated = await inbox.claim('app_two', event);
      expect(isolated).toMatchObject({ appId: 'app_two', event });
      expect(await repositories.config.list!('lark.inbox.app_two.')).toHaveLength(1);
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reopens a received message under a new boot without replacing the persisted event', async () => {
    const { directory, filename, repositories } = await openDatabase();
    let reopened = false;
    try {
      const original = message({ content: '{"text":"保留这段原文"}' });
      const firstInbox = new LarkTaskInbox(repositories.config);
      const first = await firstInbox.claim('app_one', original);
      expect(first).toBeDefined();
      repositories.close();
      reopened = true;

      const secondRepositories = createRepositories(filename);
      try {
        const secondInbox = new LarkTaskInbox(secondRepositories.config);
        expect(await secondInbox.recoverable('app_one')).toHaveLength(1);
        const replacement = message({ chatId: 'oc_other_chat', content: '{"text":"替换内容"}' });
        const recovered = await secondInbox.claim('app_one', replacement);
        expect(recovered).toMatchObject({ appId: 'app_one', event: original });
        expect(recovered?.event).not.toEqual(replacement);
        expect(recovered?.boot).not.toBe(first?.boot);
      } finally {
        secondRepositories.close();
      }
    } finally {
      if (!reopened) repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not replay accepted, failed, or command records after a restart', async () => {
    const { directory, filename, repositories } = await openDatabase();
    let reopened = false;
    try {
      const firstInbox = new LarkTaskInbox(repositories.config);
      const states = ['accepted', 'failed', 'command'] as const;
      for (const state of states) {
        const event = message({ messageId: `om_${state}` });
        const record = await firstInbox.claim('app_one', event);
        expect(record).toBeDefined();
        await firstInbox.update(record!, { state });
      }
      repositories.close();
      reopened = true;

      const secondRepositories = createRepositories(filename);
      try {
        const secondInbox = new LarkTaskInbox(secondRepositories.config);
        for (const state of states) {
          await expect(secondInbox.claim('app_one', message({ messageId: `om_${state}`, content: '重放内容' }))).resolves.toBeUndefined();
        }
      } finally {
        secondRepositories.close();
      }
    } finally {
      if (!reopened) repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns only cross-boot command receipts and gives a stale receipt a manual retry hint', async () => {
    const { directory, repositories } = await openDatabase();
    let coordinator: LarkMessageCoordinator | undefined;
    try {
      const firstInbox = new LarkTaskInbox(repositories.config);
      const staleCommand = await firstInbox.claim('app_one', message({ messageId: 'om_stale_command', senderOpenId: 'ou_alice' }));
      const accepted = await firstInbox.claim('app_one', message({ messageId: 'om_accepted' }));
      expect(staleCommand).toBeDefined();
      expect(accepted).toBeDefined();
      await firstInbox.update(staleCommand!, { state: 'command' });
      await firstInbox.update(accepted!, { state: 'accepted' });

      const beforeRestart = new LarkTaskInbox(repositories.config);
      await expect(beforeRestart.orphanedCommands('app_one')).resolves.toEqual([
        expect.objectContaining({
          event: expect.objectContaining({ messageId: 'om_stale_command' }),
          state: 'command',
          boot: staleCommand!.boot
        })
      ]);

      const reply = vi.fn(async () => ({ messageId: 'om_stale_receipt_reply' }));
      coordinator = new LarkMessageCoordinator(
        {} as any,
        { reply, listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_alice' }], hasMore: false })) } as any,
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        Math.random,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { store: repositories.config }
      );
      await coordinator.initializeWorkflows({
        appId: 'app_one',
        permissionMode: 'ask',
        allowedUsers: [],
        allowedEmails: [],
        allowedBots: [],
        peerBotsAllowed: true,
        groupToolsEnabled: false
      } as any);
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'om_stale_command',
        markdown: '重启后无法确认这条命令是否完成。如结果未生效，请重新发送该命令。'
      }));
      expect(JSON.parse((await repositories.config.get('lark.inbox.app_one.om_stale_command'))!)).toMatchObject({
        state: 'failed',
        error: '重启后无法确认命令是否完成；如未生效，请重新发送。'
      });

      const currentInbox = new LarkTaskInbox(repositories.config);
      const currentCommand = await currentInbox.claim('app_one', message({ messageId: 'om_current_command' }));
      const currentReceived = await currentInbox.claim('app_one', message({ messageId: 'om_current_received' }));
      expect(currentCommand).toBeDefined();
      expect(currentReceived).toBeDefined();
      await currentInbox.update(currentCommand!, { state: 'command' });
      expect(await currentInbox.orphanedCommands('app_one')).toEqual([]);
    } finally {
      coordinator?.stop();
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an update that loses its CAS and leaves the external record intact', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const inbox = new LarkTaskInbox(repositories.config);
      const event = message({ messageId: 'om_cas' });
      const record = await inbox.claim('app_one', event);
      expect(record).toBeDefined();
      const key = 'lark.inbox.app_one.om_cas';
      await repositories.config.set(key, JSON.stringify({ ...record, error: 'external writer' }));

      await expect(inbox.update(record!, { state: 'accepted', taskId: 'task_should_not_win' }))
        .rejects.toThrow('Lark inbox claim was lost');
      const stored = JSON.parse((await repositories.config.get(key))!);
      expect(stored).toMatchObject({ state: 'received', error: 'external writer' });
      expect(record?.state).toBe('received');
      expect(record?.taskId).toBeUndefined();
    } finally {
      repositories.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
