import { EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { runLarkEventPipeline } from '../../../apps/server/src/lark/event-pipeline';
import { createService } from '../service/main.mjs';
import { JobStore } from '../service/store.mjs';
import { APP, BOSS, COMMAND_CREATE_TIME, TOKEN, apiMessage, makeEnvelope, setupHarness, waitFor, type Harness } from './helpers/harness';

const threadId = 'omt_topic';
const rootId = 'om_root';
const messageId = 'om_command';
const eventType = 'im.message.receive_v1';
const user = { sender: { id: BOSS, id_type: 'open_id', sender_type: 'user' } };
const log = { info() {}, warn() {}, error() {} };
let h: Harness | undefined;
let resumed: Awaited<ReturnType<typeof createService>> | undefined;

afterEach(async () => {
  await resumed?.stop();
  await h?.cleanup();
  h = undefined;
  resumed = undefined;
});

function seedRoot(text: string, patch: Record<string, unknown> = {}) {
  h!.lark.messages.set(rootId, apiMessage({ messageId: rootId, text, rawExtra: user, ...patch }));
}

function seedReply(id: string, text: string, patch: Record<string, unknown> = {}) {
  h!.lark.messages.set(id, apiMessage({
    messageId: id, text, threadId, rootId, parentId: rootId, rawExtra: user, ...patch,
  }));
}

function seedMerged(id: string, text: string, root = false) {
  const wrapper = { messageType: 'merge_forward', content: 'Merged and Forwarded Message' };
  if (root) seedRoot('', wrapper);
  else seedReply(id, '', wrapper);
  h!.lark.messages.set(`${id}_child`, apiMessage({ messageId: `${id}_child`, chatId: 'oc_private', upperMessageId: id, text }));
}

async function deliver(patch: Record<string, unknown> = {}) {
  const { event } = makeEnvelope({ messageId, rootId, threadId, parentId: rootId, text: '/job', ...patch });
  const config = {
    appId: APP,
    eventHandlers: [{ id: 'rovetap-jobs', eventTypes: [eventType], url: h!.svc.url, token: TOKEN }],
  } satisfies Parameters<typeof runLarkEventPipeline>[0];
  const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
    [eventType]: (data) => runLarkEventPipeline(config, eventType, data, globalThis.fetch, log),
  });
  const { event_id, event_type, app_id, ...payload } = event;
  expect(await dispatcher.invoke({
    schema: '2.0', header: { event_id, event_type, app_id }, event: payload,
  }, { needCheck: false })).toEqual({ decision: 'stop' });
}

async function submittedMaterial() {
  await waitFor(() => h!.hub()?.submitCount === 1);
  return h!.hub().lastPayload.materials;
}

describe('RoveTap material from real-shaped topic replies', () => {
  it('finds the earlier merge forward when Feishu implicitly points the command at the topic title', async () => {
    h = await setupHarness();
    seedRoot('产品反馈'); // By ID only: the thread history does not contain the root.
    seedMerged('om_forward', '私聊反馈原话');
    seedReply('om_old_job', '@_user_1 /job 旧派单');
    seedReply('om_bot', '项目已接单', { rawExtra: { sender: { sender_type: 'app' } } });
    seedReply('om_recalled', '已撤回正文', { rawExtra: { ...user, deleted: true } });
    seedReply('om_later', '命令以后才发的反馈', { createTime: '1764000070000' });
    await deliver();
    expect(await submittedMaterial()).toEqual([{ message_id: 'om_forward', text: '私聊反馈原话' }]);
    expect(h.lark.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/messages')).map((r) => r.query))
      .toEqual([expect.objectContaining({ container_id_type: 'thread', container_id: threadId })]);
  });

  it.each(['text', 'post'])('asks for a choice between an earlier merge forward and a plain %s reply', async (messageType) => {
    h = await setupHarness();
    seedRoot('产品反馈');
    seedMerged('om_earlier', '早先的合并转发');
    const text = '后来逐条转发的私聊反馈';
    seedReply('om_later_forward', text, {
      messageType,
      createTime: '1764000030000',
      ...(messageType === 'post' ? { content: { content: [[{ tag: 'text', text }]] } } : {}),
    });
    await deliver();
    await waitFor(() => h!.svc.store.getJobByMessage(messageId)?.stage === 'needs_input' || h!.hub()?.submitCount);
    expect(h.hub()).toBeNull();
    const job = h.svc.store.getJobByMessage(messageId);
    expect(job).toMatchObject({
      reasonCode: 'multiple',
      materialChoices: [
        { messageId: 'om_earlier', preview: '早先的合并转发' },
        { messageId: 'om_later_forward', preview: text },
      ],
    });
    await h.svc.store.mutate((state) => {
      Object.assign(state.jobs[job.sourceKey], { stage: 'queued', selectedMaterialId: 'om_later_forward' });
    });
    expect(await submittedMaterial()).toEqual([{ message_id: 'om_later_forward', text }]);
  });

  it('counts a merged-forward root missing from the list, and previews only verified older forwards', async () => {
    h = await setupHarness();
    seedMerged(rootId, '话题根转发', true);
    seedMerged('om_forward', '另一条反馈');
    await deliver();
    await waitFor(() => h!.svc.store.getJobByMessage(messageId)?.stage === 'needs_input');
    expect(h.svc.store.getJobByMessage(messageId)).toMatchObject({
      reasonCode: 'multiple',
      materialChoices: [
        { messageId: rootId, preview: '话题根转发' },
        { messageId: 'om_forward', preview: '另一条反馈' },
      ],
    });
    expect(h.hub()).toBeNull();
  });

  it('uses the only older text root after recovering the thread ID from message detail', async () => {
    h = await setupHarness();
    const original = '😀'.repeat(4_100);
    seedRoot(original, { threadId });
    seedReply('om_later', '命令后发来的评论', { createTime: '1764000070000' });
    seedReply(messageId, '/job', { createTime: COMMAND_CREATE_TIME });
    await deliver({ threadId: undefined });
    const [material] = await submittedMaterial();
    expect(material.message_id).toBe(rootId);
    expect(Array.from(material.text)).toHaveLength(4_000);
    expect(material.text.endsWith('…（材料过长，已截断）')).toBe(true);
    expect(h.hub().lastPayload.thread_id).toBe(threadId);
  });

  it.each([undefined, threadId])('keeps a flat explicit quote when the quoted root thread is %s', async (rootThreadId) => {
    h = await setupHarness();
    seedRoot('用户明确引用的反馈', { threadId: rootThreadId });
    seedMerged('om_other_forward', '同一根可能有另一个话题的反馈');
    seedReply(messageId, '/job', { threadId: undefined, createTime: COMMAND_CREATE_TIME });
    await deliver({ threadId: undefined });
    await waitFor(() => h!.svc.store.getJobByMessage(messageId)?.stage === 'needs_input' || h!.hub()?.submitCount);
    expect(h.hub()?.lastPayload.materials).toEqual([{ message_id: rootId, text: '用户明确引用的反馈' }]);
    expect(h.lark.requests.some((r) => r.method === 'GET' && r.path.endsWith('/messages'))).toBe(false);
  });

  it('does not use the root thread when the command detail cannot establish its own scope', async () => {
    h = await setupHarness();
    seedRoot('产品反馈', { threadId });
    seedMerged('om_other_forward', '同一根下另一话题的内容');
    await deliver({ threadId: undefined });
    await waitFor(() => h!.svc.store.getJobByMessage(messageId)?.stage === 'needs_input' || h!.hub()?.submitCount);
    expect(h.hub()).toBeNull();
    expect(h.lark.requests.some((r) => r.method === 'GET' && r.path.endsWith('/messages'))).toBe(false);
  });

  it('uses an explicitly quoted non-root reply before any topic discovery', async () => {
    h = await setupHarness();
    seedReply('om_quoted', '用户明确引用的文本');
    seedMerged('om_other_forward', '另一条转发');
    await deliver({ parentId: 'om_quoted' });
    expect(await submittedMaterial()).toEqual([{ message_id: 'om_quoted', text: '用户明确引用的文本' }]);
    expect(h.lark.requests.some((r) => r.method === 'GET' && r.path.endsWith('/messages'))).toBe(false);
  });

  it('recovers a missing root from the command detail before classifying its parent', async () => {
    h = await setupHarness();
    seedRoot('产品反馈');
    seedMerged('om_forward', '待处理的转发正文');
    seedReply(messageId, '/job', { createTime: COMMAND_CREATE_TIME });
    await deliver({ rootId: undefined });
    expect(await submittedMaterial()).toEqual([{ message_id: 'om_forward', text: '待处理的转发正文' }]);
  });

  it('publishes a short verified choice list and re-reads the exact selected root after restart', async () => {
    h = await setupHarness();
    seedRoot('标题\n与正文');
    seedReply('om_feedback', '😀'.repeat(100));
    seedReply('om_old_job', '@_user_1 /job 旧任务');
    seedReply('om_bot', '机器人回执', { rawExtra: { sender: { sender_type: 'app' } } });
    seedReply('om_wrong_chat', '不能显示的私聊', { chatId: 'oc_other' });
    seedReply('om_late', '不能选择的迟到反馈', { createTime: '1764000070000' });
    seedReply(messageId, '/job 保留原指令', { createTime: COMMAND_CREATE_TIME });
    await deliver({ text: '/job 保留原指令', messageExtra: { create_time: undefined } });
    await waitFor(() => h!.svc.store.getJobByMessage(messageId)?.stage === 'needs_input');
    const original = h.svc.store.getJobByMessage(messageId);
    expect(original.materialChoices).toEqual([
      { messageId: rootId, preview: '标题 与正文' },
      { messageId: 'om_feedback', preview: `${'😀'.repeat(79)}…` },
    ]);
    expect(original.materialChoicesExpireAt).toBeGreaterThan(Date.now());
    expect(original.commandCreateTime).toBe(COMMAND_CREATE_TIME);
    expect(h.hub()).toBeNull();
    await h.svc.stop();

    // Persist the verified selection as the handler does, then open a fresh
    // worker so this test exercises recovery before submission.
    const offlineStore = await JobStore.open(h.dir);
    await offlineStore.mutate((state) => {
      const job = state.jobs[original.sourceKey];
      expect(job.materialChoices).toEqual(original.materialChoices);
      job.stage = 'queued';
      job.selectedMaterialId = rootId;
    });
    await offlineStore.close();

    seedRoot('标题与重新读到的正文');
    h.lark.messages.delete(messageId);
    resumed = await createService(h.config, { logger: log });
    expect(await submittedMaterial()).toEqual([{ message_id: rootId, text: '标题与重新读到的正文' }]);
    expect(h.hub().lastPayload).toMatchObject({
      source_key: `lark/${APP}/${messageId}`, actor: { app_id: APP, open_id: BOSS }, instruction: '保留原指令',
    });
  });

  it('refuses to substitute another message if the selected reply was recalled', async () => {
    h = await setupHarness();
    seedRoot('产品反馈');
    seedReply('om_selected', '将被撤回的材料');
    await deliver();
    await waitFor(() => h!.svc.store.getJobByMessage(messageId)?.stage === 'needs_input');
    const original = h.svc.store.getJobByMessage(messageId);
    expect(original.materialChoices).toHaveLength(2);
    h.lark.messages.delete('om_selected');
    await h.svc.store.mutate((state) => {
      Object.assign(state.jobs[original.sourceKey], { stage: 'queued', selectedMaterialId: 'om_selected' });
    });
    await waitFor(() => h!.svc.store.getJobByMessage(messageId)?.reasonCode === 'selected_material_unavailable');
    const updated = h.svc.store.getJobByMessage(messageId);
    expect(updated.materialChoices).toEqual([]);
    expect(updated.replies['need:selected']).toBeDefined();
    expect(h.hub()).toBeNull();
  });
});
