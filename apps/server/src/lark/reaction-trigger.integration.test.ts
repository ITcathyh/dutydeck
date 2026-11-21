import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollaborationAction } from '@dutydeck/shared';
import { LarkServiceError } from './service.js';
import { createAlarmHarness, SCENARIO_BOT, SCENARIO_MEMBER, SCENARIO_REQUESTER } from './scenario-pack.test-helpers.js';

const messageId = 'om_reacted';
const emoji = 'THUMBSUP';
const threadId = 'omt_existing';
const rootId = 'om_root';
const text = '整理这条发布问题';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function harness(options: Parameters<typeof createAlarmHarness>[0] = {}) {
  const h = await createAlarmHarness({ participation: 'off', ...options, configPatch: { reactionTriggerEmoji: emoji, ...options.configPatch } });
  cleanups.push(h.close);
  h.fromUser({ messageId, text, sender: SCENARIO_MEMBER, threadId, rootId });
  const trigger = (actor = SCENARIO_REQUESTER, reaction = emoji) => h.coordinator.handleReaction(messageId, reaction, actor, h.config);
  const records = async () => (await h.repos.collaboration.listActions(h.scope)).filter(action => action.kind.startsWith('confirm.reaction_task'));
  const click = (record: CollaborationAction, decision: 'confirm' | 'cancel' = 'confirm', actor = SCENARIO_REQUESTER) =>
    h.coordinator.handleAction({ dutydeck_confirm: decision, confirm_id: record.id, chat_id: h.scope.chatId }, actor, { chatId: h.scope.chatId, messageId: record.receipt });
  const outbound = () => h.calls.filter(call => ['reply', 'replyText', 'send', 'addReaction'].includes(call.method));
  return { ...h, trigger, records, click, outbound };
}

describe('reaction task confirmation', () => {
  it('ignores the default-off state, mismatched emoji and members blocked by group policy', async () => {
    const h = await harness();
    await h.coordinator.handleReaction(messageId, emoji, SCENARIO_REQUESTER, { ...h.config, reactionTriggerEmoji: undefined });
    await h.trigger(SCENARIO_REQUESTER, 'SMILE');
    const binding = (await h.groupManager.groupAccess(h.config.appId, h.scope.chatId))!;
    await h.groupManager.save(h.config.appId, h.scope.chatId, { expectedRevision: binding.revision, patch: { accessOverride: { mode: 'owner_only', principalIds: [] } } });
    await h.trigger('ou_outsider');
    expect(h.outbound()).toHaveLength(0);
    expect(await h.records()).toHaveLength(0);
  });

  it.each([
    ['non-text message', { messageType: 'image' }],
    ['deleted message', { deleted: true }],
    ['own app message', { sender: { type: 'app', idType: 'app_id', id: SCENARIO_BOT.appId } }],
    ['own bot message', { sender: { type: 'bot', idType: 'open_id', id: SCENARIO_BOT.openId } }]
  ])('ignores a reaction on a %s', async (_label, patch) => {
    const h = await harness();
    h.messages.set(messageId, { ...h.messages.get(messageId)!, ...patch });
    await h.trigger();
    expect(h.outbound()).toHaveLength(0);
    expect(await h.records()).toHaveLength(0);
  });

  it('renders a Unicode-safe excerpt from another app’s rich text', async () => {
    const h = await harness();
    const prefix = '工'.repeat(198);
    h.messages.set(messageId, { ...h.messages.get(messageId)!, sender: { type: 'app', idType: 'app_id', id: 'cli_other' },
      messageType: 'post', rawContent: JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: `${prefix}🙂后续` }]] } }) });
    await h.trigger();
    expect(h.outbound()).toHaveLength(1);
    const reply = h.outbound()[0]?.input as { elements: Array<{ element_id?: string; content?: string }> };
    expect(reply.elements.find(element => element.element_id === 'confirm_body')?.content?.split('\n\n> ').at(-1)).toBe(`${prefix}…`);
  });

  it('posts one card per actor under the source message and accepts only the actor once', async () => {
    const h = await harness();
    await Promise.all([h.trigger(), h.trigger(), h.trigger(SCENARIO_MEMBER)]);
    const records = await h.records();
    expect(records.map(record => record.requesterId).sort()).toEqual([SCENARIO_MEMBER, SCENARIO_REQUESTER].sort());
    expect(h.outbound()).toHaveLength(2);
    const record = records.find(row => row.requesterId === SCENARIO_REQUESTER)!;
    const reply = h.outbound().find(call => JSON.stringify(call.input).includes(record.id));
    expect(reply?.input).toMatchObject({ messageId, replyInThread: true, statusLabel: '待确认' });
    expect(JSON.stringify(reply?.input)).toContain('开始处理');
    expect(JSON.stringify(reply?.input)).toContain('取消');
    expect(JSON.stringify(reply?.input)).toContain(SCENARIO_REQUESTER);
    expect(JSON.stringify(reply?.input)).toContain(text);
    expect(h.prompts).toEqual([]);

    for (const decision of ['confirm', 'cancel'] as const) {
      await expect(h.click(record, decision, SCENARIO_MEMBER)).resolves.toMatchObject({ type: 'warning' });
    }
    expect((await h.records()).find(row => row.id === record.id)?.status).toBe('intent');
    const clicks = await Promise.all([h.click(record), h.click(record)]);
    expect(clicks.map(reply => reply?.type).sort()).toEqual(['info', 'success']);
    await expect.poll(() => h.prompts.length).toBe(1);
    const [task] = await h.mappings();
    expect(task?.saved).toMatchObject({ anchor_message_id: record.receipt, sender_open_id: SCENARIO_REQUESTER, thread_id: threadId, scope_id: `thread:${rootId}` });
    expect((await h.inboxRecord(task!.externalId))?.event).toMatchObject({ parentId: messageId, replyMessageId: record.receipt });
    expect(h.prompts[0]).toContain(text);
    await h.settle(task!.externalId);
    expect(h.prompts).toHaveLength(1);
    expect(h.calls).toContainEqual(expect.objectContaining({ method: 'update', input: expect.objectContaining({ messageId: record.receipt, statusLabel: '已开始' }) }));
    expect(h.authorizations).toContainEqual(expect.objectContaining({ actor: SCENARIO_REQUESTER, action: 'task.create' }));
  });

  it.each(['edited', 'recalled', 'missing', 'upstream missing'] as const)('rejects a confirmation after the source is %s', async change => {
    const h = await harness();
    await h.trigger();
    const [record] = await h.records();
    const before = h.messages.get(messageId)!;
    const revised = '补上修改后的发布说明';
    if (change === 'missing') vi.spyOn(h.service, 'getMessage').mockRejectedValueOnce(new LarkServiceError('LARK_MESSAGE_NOT_FOUND', 'Message not found', 404));
    else if (change === 'upstream missing') vi.spyOn(h.service, 'getMessage').mockRejectedValueOnce(new LarkServiceError('LARK_REQUEST_FAILED', 'Message not found', 400, { upstreamCode: 230001 }));
    else h.messages.set(messageId, { ...before, ...(change === 'edited'
      ? { rawContent: JSON.stringify({ text: revised }), updated: true } : { deleted: true }) });

    const explanation = '原消息在发卡后被修改或撤回，没有开始处理。需要的话请取消表情后重新点一次。';
    await expect(h.click(record!)).resolves.toMatchObject({ type: 'error', content: expect.stringContaining(explanation) });
    expect((await h.records())[0]?.status).toBe('failed');
    expect(h.calls).toContainEqual(expect.objectContaining({ method: 'update', input: expect.objectContaining({
      messageId: record?.receipt, state: 'failed', elements: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining(explanation) })])
    }) }));
    expect(await h.mappings()).toEqual([]);
    expect(h.prompts).toEqual([]);

    if (change === 'edited') {
      await Promise.all([h.trigger(), h.trigger()]);
      const records = await h.records();
      expect(records).toHaveLength(2);
      const next = records.find(item => item.id !== record!.id)!;
      expect(next.receipt).not.toBe(record?.receipt);
      expect(JSON.stringify(h.outbound().at(-1)?.input)).toContain(revised);
      await expect(h.click(next)).resolves.toMatchObject({ type: 'success' });
      await expect.poll(() => h.prompts.length).toBe(1);
      expect(h.prompts[0]).toContain(revised);
      await h.settle((await h.mappings())[0]!.externalId);
    }
  });

  it('accepts live reaction and confirmation actors when the group member list is unavailable', async () => {
    const h = await harness();
    const lookup = vi.spyOn(h.groupManager as unknown as { isMember(): Promise<boolean> }, 'isMember')
      .mockRejectedValue(new Error('群成员列表不可用'));
    await h.trigger();
    const [record] = await h.records();
    expect(record?.receipt).toBeDefined();
    expect(lookup).not.toHaveBeenCalled();
    await expect(h.click(record!)).resolves.toMatchObject({ type: 'success' });
    lookup.mockRestore();
    expect((await h.inboxRecord(`reaction_${record!.id}`))?.event).toMatchObject({ senderOpenId: SCENARIO_REQUESTER, parentId: messageId });
    expect(h.authorizations.filter(call => call.action === 'task.create').slice(0, 2)).toEqual([
      { actor: SCENARIO_REQUESTER, action: 'task.create', memberObserved: true },
      { actor: SCENARIO_REQUESTER, action: 'task.create', memberObserved: true }
    ]);
  });

  it('lets the current group policy block a requester whose access was revoked after the card was sent', async () => {
    const h = await harness();
    await h.trigger();
    const [record] = await h.records();
    const binding = (await h.groupManager.groupAccess(h.config.appId, h.scope.chatId))!;
    await h.groupManager.save(h.config.appId, h.scope.chatId, { expectedRevision: binding.revision, patch: { state: 'disabled' } });
    await expect(h.click(record!)).resolves.toMatchObject({ type: 'warning' });
    expect(h.prompts).toEqual([]);
    expect((await h.records())[0]?.status).toBe('intent');
  });

  it('uses the original message as the scope root for a native topic seed', async () => {
    const h = await harness();
    h.messages.set(messageId, { ...h.messages.get(messageId)!, rootId: undefined });
    await h.trigger();
    const [record] = await h.records();
    await h.click(record!);
    await expect.poll(() => h.prompts.length).toBe(1);
    const [task] = await h.mappings();
    expect(task?.saved).toMatchObject({ scope_id: `thread:${messageId}`, thread_id: threadId });
    await h.settle(task!.externalId);
  });

  it('keeps deduplication when collaboration retention has removed an old confirmation', async () => {
    const h = await harness();
    await h.trigger();
    const [record] = await h.records();
    await h.click(record!, 'cancel');
    await h.repos.collaboration.pruneObservations(new Date(Date.now() + 48 * 3_600_000).toISOString(), h.scope);
    expect(await h.records()).toHaveLength(0);
    await h.trigger();
    expect(h.outbound()).toHaveLength(1);
  });

  it.each(['cancel', 'expire'] as const)('updates a card on %s and keeps its deduplication', async decision => {
    let now = Date.now();
    const h = await harness({ now: () => new Date(now) });
    await h.trigger();
    const [record] = await h.records();
    if (decision === 'expire') now += 25 * 3_600_000;
    await expect(h.click(record!, decision === 'cancel' ? 'cancel' : 'confirm')).resolves.toMatchObject({ type: decision === 'cancel' ? 'info' : 'warning' });
    expect(h.calls).toContainEqual(expect.objectContaining({ method: 'update', input: expect.objectContaining({
      messageId: record?.receipt, statusLabel: decision === 'cancel' ? '已取消' : '已过期'
    }) }));
    await h.trigger();
    expect(h.outbound()).toHaveLength(1);
    expect(h.prompts).toEqual([]);
  });

  it('does not repost or rerun a confirmed reaction after recreating the runtime on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-reaction-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = await harness({ directory });
    await first.trigger();
    const [record] = await first.records();
    await first.click(record!);
    await expect.poll(() => first.prompts.length).toBe(1);
    await first.settle((await first.mappings())[0]!.externalId);
    cleanups.pop();
    await first.close();

    const second = await harness({ directory, configPatch: { reactionTriggerEmoji: 'SMILE' } });
    await second.trigger(SCENARIO_REQUESTER, 'SMILE');
    await expect(second.click(record!)).resolves.toMatchObject({ type: 'info' });
    expect(second.outbound()).toHaveLength(0);
    expect(await second.records()).toHaveLength(1);
    expect(second.prompts).toEqual([]);
  });

  it('recovers a confirmed reaction already in the inbox when routing has not run yet', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dutydeck-reaction-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = await harness({ directory });
    await first.trigger();
    const [record] = await first.records();
    await expect(first.click(record!)).resolves.toMatchObject({ type: 'success' });
    const entries = await first.repos.config.list!(`lark.inbox.${first.config.appId}.`);
    expect(entries).toHaveLength(1);
    const pending = JSON.parse(entries[0]!.value);
    expect(pending).toMatchObject({ state: 'unrouted', event: { senderOpenId: SCENARIO_REQUESTER, parentId: messageId } });
    expect(first.prompts).toEqual([]);
    cleanups.pop();
    await first.close();

    const second = await harness({ directory });
    await expect.poll(() => second.prompts.length).toBe(1);
    await second.settle(pending.event.messageId);
    await expect(second.click(record!)).resolves.toMatchObject({ type: 'info' });
    expect(second.prompts).toHaveLength(1);
  });
});
