import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { LarkMessageCoordinator } from './coordinator.js';
import { larkConfirmationInputDigest, LarkTaskInbox } from './task-inbox.js';
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
  it('durably captures before routing, preserves the first payload, and recovers in receipt order', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const inbox = new LarkTaskInbox(repositories.config);
      const original = message({ messageId: 'om_z', content: '{"text":"original"}' });
      const captures = await Promise.all([inbox.capture('app_one', original), inbox.capture('app_one', { ...original, content: '{"text":"replacement"}' })]);
      expect(captures.filter(Boolean)).toHaveLength(1);
      expect(await inbox.lookup('app_one', original.messageId)).toMatchObject({ state: 'unrouted', event: original });
      await inbox.capture('app_one', message({ messageId: 'om_a' }));
      const restarted = new LarkTaskInbox(repositories.config);
      expect((await restarted.recoverable('app_one')).map(record => record.event.messageId)).toEqual(['om_z', 'om_a']);
      const claimed = await restarted.claim('app_one', { ...original, content: '{"text":"forged"}' });
      expect(claimed).toMatchObject({ state: 'received', event: original });
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('drops internal scenario, legacy triage and reply-anchor fields from a raw event on capture and on an edited reopen', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const inbox = new LarkTaskInbox(repositories.config);
      const forged = { authorization: { strength: 'explicit' as const, via: 'participation_confirmed' as const, decisionId: 'forged' }, scenario: { mode: 'direct' as const, packId: 'demo', version: '1.0.0', digest: 'd', instruction: 'forged', sourceAppId: 'cli_src', recordId: 'r' }, triage: 'forged', replyMessageId: 'om_forged_anchor' };
      const original = message({ messageId: 'om_forged' });
      const captured = (await inbox.capture('app_one', { ...original, ...forged }))!;
      expect(captured.event).toEqual(original);
      await inbox.update(captured, { state: 'ignored' });
      const edited = message({ messageId: 'om_forged', content: '{"text":"edited"}' });
      await inbox.reopenIgnored('app_one', { ...edited, ...forged });
      expect(await inbox.lookup('app_one', 'om_forged')).toMatchObject({ state: 'unrouted', event: edited, originalEvent: original });
      expect((await inbox.lookup('app_one', 'om_forged'))!.event).toEqual(edited);
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('bounds ignored retention without deleting active receipts or allowing CAS deletion to remove a changed record', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const inbox = new LarkTaskInbox(repositories.config);
      const active = await inbox.capture('app_one', message({ messageId: 'active' }));
      for (let index = 0; index < 5; index++) {
        const record = (await inbox.capture('app_one', message({ messageId: `ignored_${index}` })))!;
        await inbox.update(record, { state: 'ignored' });
      }
      await inbox.pruneIgnored('app_one', 2);
      expect((await repositories.config.list!('lark.inbox.app_one.')).map(row => JSON.parse(row.value).state).sort()).toEqual(['ignored', 'ignored', 'unrouted']);
      expect(await inbox.lookup('app_one', 'active')).toEqual(active);
      const row = (await repositories.config.list!('lark.inbox.app_one.')).find(row => JSON.parse(row.value).state === 'ignored')!;
      await repositories.config.set(row.key, JSON.stringify({ ...JSON.parse(row.value), state: 'accepted' }));
      expect(await repositories.config.remove!(row.key, row.value)).toBe(false);
      await expect(repositories.config.remove!('lark.inbox.app_one.active', JSON.stringify(active))).rejects.toThrow();
      for (const key of ['lark.bots', 'runtime_native_context:session', 'bot.process', 'migration.marker']) await expect(repositories.config.remove!(key, '{}')).rejects.toThrow();
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps at most 5000 recent ignored receipts and removes 30-day-old ignored records without touching received inputs', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const inbox = new LarkTaskInbox(repositories.config);
      await inbox.claim('app_one', message({ messageId: 'received' }));
      const at = new Date().toISOString();
      const writes = Array.from({ length: 5001 }, (_, index) => {
        const event = message({ messageId: `ignored_${index}` });
        return { key: `lark.inbox.app_one.${event.messageId}`, value: JSON.stringify({ appId: 'app_one', event, boot: '', state: 'ignored', receivedAt: at, receiptOrder: index }) };
      });
      expect(await repositories.config.compareAndSetBatch!([], writes)).toBe(true);
      await repositories.config.set('lark.inbox.app_one.expired', JSON.stringify({ appId: 'app_one', event: message({ messageId: 'expired' }), boot: '', state: 'ignored', receivedAt: new Date(Date.now() - 30 * 86_400_000 - 1).toISOString() }));
      await inbox.pruneIgnored('app_one');
      const rows = await repositories.config.list!('lark.inbox.app_one.');
      expect(rows).toHaveLength(5001);
      expect(rows.filter(row => JSON.parse(row.value).state === 'ignored')).toHaveLength(5000);
      expect(await inbox.lookup('app_one', 'expired')).toBeUndefined();
      expect(await inbox.lookup('app_one', 'ignored_0')).toBeUndefined();
      expect(await inbox.lookup('app_one', 'received')).toMatchObject({ state: 'received' });
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps a 29-day ignored receipt, records duplicate deliveries, and preserves accepted state', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const inbox = new LarkTaskInbox(repositories.config);
      const record = (await inbox.capture('app_one', message()))!;
      await inbox.update(record,{state:'ignored',reason:'not_addressed'});
      const key = 'lark.inbox.app_one.om_original';
      await repositories.config.set(key,JSON.stringify({...record,receivedAt:new Date(Date.now()-29*86400000).toISOString()}));
      await inbox.pruneIgnored('app_one');
      expect(await inbox.lookup('app_one','om_original')).toBeDefined();
      expect(await inbox.capture('app_one',message({content:'replacement'}))).toBeUndefined();
      expect(await inbox.lookup('app_one','om_original')).toMatchObject({duplicateCount:1,reason:'not_addressed',event:message()});
    } finally { repositories.close(); await rm(directory,{recursive:true,force:true}); }
  });

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

  it('serializes preparation and cancellation patches without losing the terminal state', async () => {
    const { directory, repositories } = await openDatabase();
    try {
      const inbox = new LarkTaskInbox(repositories.config);
      const record = (await inbox.claim('app_one', message()))!;
      await Promise.all([
        inbox.update(record, { sessionId: 'ses_pending' }),
        inbox.update(record, { state: 'failed', error: 'superseded' }),
        inbox.update(record, { cardId: 'om_receipt' })
      ]);
      expect(JSON.parse((await repositories.config.get('lark.inbox.app_one.om_original'))!))
        .toMatchObject({ state: 'failed', sessionId: 'ses_pending', cardId: 'om_receipt', error: 'superseded' });
      expect(await new LarkTaskInbox(repositories.config).recoverable('app_one')).toEqual([]);
    } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
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

it.each(['update','ownUnrouted','release','adoptAccepted','claim'] as const)('retries metadata written between %s read and CAS', async operation => {
 const {directory,repositories} = await openDatabase();
 try {
  const inbox = new LarkTaskInbox(repositories.config);
  const record = (await inbox.capture('app_one',message()))!;
  if (operation === 'adoptAccepted') await inbox.update(record,{state:'accepted'});
  if (operation === 'release') await inbox.update(record,{state:'received'});
  const original = repositories.config.compareAndSet!.bind(repositories.config);
  const key = 'lark.inbox.app_one.om_original';
  const spy = vi.spyOn(repositories.config,'compareAndSet').mockImplementationOnce(async (target,expected,next) => {
    const current = JSON.parse((await repositories.config.get(key))!);
    await repositories.config.set(key,JSON.stringify({...current,duplicateCount:1,reason:'participation_silent',detail:'audit only',disposition:{schemaVersion:1,reason:'participation_silent',decisionId:'audit_decision'}}));
    return original(target,expected,next);
  });
  const result = operation === 'update' ? await inbox.update(record,{cardId:'card'}) : operation === 'claim' ? await inbox.claim('app_one',message()) : await inbox[operation](record);
  if (operation !== 'update') expect(result).toBeDefined();
  expect(await inbox.lookup('app_one','om_original')).toMatchObject({duplicateCount:1,reason:'participation_silent',disposition:{decisionId:'audit_decision'},...(operation==='update'?{cardId:'card'}:{})});
  spy.mockRestore();
 } finally {repositories.close(); await rm(directory,{recursive:true,force:true});}
});

it('keeps its execution snapshot after clearing and rewriting session material', async () => {
  const { directory, repositories } = await openDatabase();
  try {
    const inbox = new LarkTaskInbox(repositories.config);
    const record = (await inbox.claim('app_one', message()))!;
    await inbox.update(record, { sessionId: 'old', materials: { prompt: 'old', readMessageIds: [] }, cardId: 'card' });
    await inbox.update(record, { sessionId: undefined, materials: undefined, lineage: { sessionId: 'old', relation: 'retry' } });
    await inbox.update(record, { sessionId: 'new', materials: { prompt: 'new', readMessageIds: [] } });
    await inbox.update(record, { state: 'accepted', taskId: 'new_task' });
    expect(await inbox.lookup('app_one', record.event.messageId)).toMatchObject({ sessionId: 'new', state: 'accepted', taskId: 'new_task', lineage: { sessionId: 'old', relation: 'retry' } });
  } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
});

it.each(['authorization', 'lineage'] as const)('rejects execution drift in %s while retrying audit-only CAS writes', async field => {
  const { directory, repositories } = await openDatabase();
  try {
    const inbox = new LarkTaskInbox(repositories.config);
    const authorization = { strength: 'explicit' as const, via: 'participation_confirmed' as const, decisionId: 'trusted' };
    await inbox.capture('app_one', message());
    const record = (await inbox.claim('app_one', message(), false, { authorization }))!;
    expect(record.event.authorization).toEqual(authorization);
    await inbox.update(record, { lineage: { sessionId: 'source', relation: 'retry' } });
    const key = 'lark.inbox.app_one.om_original';
    const original = repositories.config.compareAndSet!.bind(repositories.config);
    vi.spyOn(repositories.config, 'compareAndSet').mockImplementationOnce(async (target, expected, next) => {
      const current = JSON.parse((await repositories.config.get(key))!);
      const changed = field === 'authorization' ? { ...current, event: { ...current.event, authorization: { ...authorization, decisionId: 'other' } } }
        : { ...current, lineage: { sessionId: 'other', relation: 'retry' } };
      await repositories.config.set(key, JSON.stringify(changed));
      return original(target, expected, next);
    });
    await expect(inbox.update(record, { taskId: 'must_not_win' })).rejects.toThrow('Lark inbox claim was lost');
    const latest = (await inbox.lookup('app_one', record.event.messageId))!;
    expect(latest.taskId).toBeUndefined();
    expect(field === 'authorization' ? latest.event.authorization?.decisionId : latest.lineage?.sessionId).toBe('other');
  } finally { vi.restoreAllMocks(); repositories.close(); await rm(directory, { recursive: true, force: true }); }
});

it('ignores nested JSON object key order while rejecting reordered execution arrays', async () => {
  const { directory, repositories } = await openDatabase();
  try {
    const inbox = new LarkTaskInbox(repositories.config);
    const record = (await inbox.claim('app_one', message({
      authorization: { strength: 'explicit', via: 'mention' },
      mentions: [{ key: 'one', name: 'One', openId: 'ou_one' }, { key: 'two', name: 'Two', openId: 'ou_two' }]
    })))!;
    const key = 'lark.inbox.app_one.om_original';
    const current = JSON.parse((await repositories.config.get(key))!);
    current.event.authorization = Object.fromEntries(Object.entries(current.event.authorization).reverse());
    current.event = Object.fromEntries(Object.entries(current.event).reverse());
    await repositories.config.set(key, JSON.stringify(current));
    await inbox.update(record, { cardId: 'card' });
    const changed = JSON.parse((await repositories.config.get(key))!);
    changed.event.mentions.reverse();
    await repositories.config.set(key, JSON.stringify(changed));
    await expect(inbox.update(record, { taskId: 'must_not_win' })).rejects.toThrow('Lark inbox claim was lost');
    expect((await inbox.lookup('app_one', record.event.messageId))?.event.mentions[0]?.openId).toBe('ou_two');
  } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
});


it.each(['file key', 'file name', 'routing', 'message version'] as const)('binds an ignored request to frozen %s at the claim CAS', async changed => {
  const { directory, repositories } = await openDatabase();
  try {
    const inbox = new LarkTaskInbox(repositories.config);
    const original = message({ messageType: 'file', content: JSON.stringify({ file_key: 'old_key', file_name: 'old.txt' }), createTime: '100', rootId: 'om_root', senderOpenId: 'ou_author', senderType: 'user' });
    const captured = (await inbox.capture('app_one', original))!;
    await inbox.update(captured, { state: 'ignored' });
    const edited = { ...original, ...(changed === 'file key' ? { content: JSON.stringify({ file_key: 'new_key', file_name: 'old.txt' }) }
      : changed === 'file name' ? { content: JSON.stringify({ file_key: 'old_key', file_name: 'new.txt' }) }
      : changed === 'routing' ? { rootId: 'other_root' } : { createTime: '101' }) };
    await inbox.reopenIgnored('app_one', edited);
    expect((await inbox.lookup('app_one', original.messageId))?.originalEvent).toEqual(original);
    await expect(inbox.claim('app_one', original, true, { senderOpenId: 'ou_confirmer', senderType: 'user', confirmedInputDigest: larkConfirmationInputDigest(original) }))
      .rejects.toMatchObject({ code: 'LARK_CONFIRMATION_INPUT_CHANGED' });
    expect((await inbox.lookup('app_one', original.messageId))?.state).toBe('unrouted');
  } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
});
it('accepts the frozen request as the confirmer once without persisting the transient guard in its event', async () => {
  const { directory, repositories } = await openDatabase();
  try {
    const inbox = new LarkTaskInbox(repositories.config); const event = message({ senderOpenId: 'ou_author', senderType: 'user' });
    const captured = (await inbox.capture('app_one', event))!; await inbox.update(captured, { state: 'ignored' });
    const adoption = { senderOpenId: 'ou_confirmer', senderType: 'user', authorization: { strength: 'explicit' as const, via: 'participation_confirmed' as const }, confirmedInputDigest: larkConfirmationInputDigest(event) };
    const claimed = await inbox.claim('app_one', event, true, adoption);
    expect(claimed?.event).toEqual({ ...event, senderOpenId: 'ou_confirmer', authorization: adoption.authorization });
    expect(await inbox.claim('app_one', event, true, adoption)).toBeUndefined();
  } finally { repositories.close(); await rm(directory, { recursive: true, force: true }); }
});
