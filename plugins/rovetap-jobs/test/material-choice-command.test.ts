import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { materialChoiceCode, parseJobCommand } from '../service/commands.mjs';
import { receiveEnvelope } from '../service/handler.mjs';
import { replyText } from '../service/messages.mjs';
import { JobStore, sourceKeyFor } from '../service/store.mjs';
import { APP, BOSS, CHAT, OTHER, TOKEN, apiMessage, makeEnvelope, setupHarness, waitFor } from './helpers/harness';

const topic = { threadId: 'omt_selection', rootId: 'om_root' };
const first = { messageId: 'om_first', preview: '草稿在切回前台后消失' };
const second = { messageId: 'om_second', preview: '从搜索结果打不开文件' };
const config = {
  appId: APP, handlerToken: TOKEN, selfOpenId: 'ou_bot',
  allowedChatIds: new Set([CHAT, 'oc_other']), commanderOpenIds: new Set([BOSS, OTHER]),
  pairfob: { project: 'rovetap' }, projectAliases: new Set(['rovetap']), limits: { maxInstructionChars: 4000 },
};

describe('topic material choice commands', () => {
  let dir: string;
  let store: InstanceType<typeof JobStore>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rvj-choice-'));
    store = await JobStore.open(dir);
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const deliver = (body: ReturnType<typeof makeEnvelope>) => receiveEnvelope(
    { body, authorization: `Bearer ${TOKEN}` }, { config, store },
  );

  async function offer(messageId: string, instruction = '复现反馈并回报', expiresAt = Date.now() + 60_000, senderType = 'user') {
    await deliver(makeEnvelope({ ...topic, messageId, senderType, text: `/job ${instruction}` }));
    const key = sourceKeyFor(APP, messageId);
    expect(store.getJob(key)).toMatchObject({ stage: 'queued', commanderOpenId: BOSS, commanderSenderType: senderType });
    await store.mutate(state => {
      Object.assign(state.jobs[key], {
        stage: 'needs_input', reasonCode: 'multiple', materialChoices: [first, second], materialChoicesExpireAt: expiresAt,
      });
      store.outbound(state, key, 'need').status = 'sent';
    });
    return key;
  }

  it('reserves the #code form and keeps ordinary Chinese and English instructions', () => {
    expect(parseJobCommand('/JOB 选 #A023F12005')).toEqual({ kind: 'select-material', code: 'a023f12005' });
    for (const text of ['/job 选 #', '/job 选 #abc', '/job 选 #000000000g', '/job 选 #a023f12005 extra']) {
      expect(parseJobCommand(text)).toEqual({ kind: 'select-material', code: null });
    }
    expect(parseJobCommand('/job 选 Rust 写一个实现')).toMatchObject({ kind: 'job', instruction: '选 Rust 写一个实现' });
    expect(parseJobCommand('/job choose a test case')).toMatchObject({ kind: 'job', instruction: 'choose a test case' });
  });

  it.each(['user', 'app', 'bot'])('chooses the original record among multiple offers from the same %s', async (senderType) => {
    const earlier = await offer('om_earlier', '调查问题', undefined, senderType);
    const original = await offer('om_original', '请补回归测试', undefined, senderType);
    const reply = replyText('need', store.getJob(original), config);
    const command = `/job 选 #${materialChoiceCode(original, first.messageId)}`;
    expect(reply.split('\n')).toContain(command);
    expect(reply).not.toContain(materialChoiceCode(earlier, first.messageId));

    const chosen = await deliver(makeEnvelope({ threadId: topic.threadId, messageId: 'om_choice', senderType, text: command }));
    expect(chosen.kickSourceKey).toBe(original);
    expect(store.getJobByMessage('om_choice')).toMatchObject({
      sourceKey: original, messageId: 'om_original', instruction: '请补回归测试', selectedMaterialId: first.messageId, stage: 'queued',
      replies: { need: { status: 'sent', supersededAt: expect.any(String) } },
    });
    expect(store.getJob(earlier)).toMatchObject({ stage: 'needs_input' });
    expect(store.listJobs()).toHaveLength(2);
  });

  it('refuses a flat group quote of the same root, so the real topic can still select', async () => {
    const original = await offer('om_original');
    const before = structuredClone(store.getJob(original));
    const text = `/job 选 #${materialChoiceCode(original, first.messageId)}`;
    const flat = makeEnvelope({ rootId: topic.rootId, parentId: topic.rootId, messageId: 'om_flat_choice', text });
    const denied = await deliver(flat);
    expect(denied.body).toEqual({ event_id: flat.event.event_id, decision: 'stop' });
    const rejected = store.getJobByMessage('om_flat_choice');
    expect(rejected).toMatchObject({ stage: 'denied', reasonCode: 'selection_topic_required', replyAnchor: 'om_flat_choice' });
    expect(replyText('denial', rejected, config)).toContain('打开原话题');
    expect(store.getJob(original)).toEqual(before);

    const accepted = await deliver(makeEnvelope({ ...topic, messageId: 'om_topic_choice', text }));
    expect(accepted.kickSourceKey).toBe(original);
    expect(store.getJob(original)).toMatchObject({ selectedMaterialId: first.messageId, stage: 'queued' });
  });

  it('declines invalid, expired, wrong-actor and wrong-topic choices in the inbound topic', async () => {
    const expired = await offer('om_expired', '较早的委托', Date.now() - 1);
    const original = await offer('om_original');
    const valid = `/job 选 #${materialChoiceCode(original, first.messageId)}`;
    const cases = [
      { text: valid, openId: OTHER, senderType: 'app' },
      { text: valid, chatId: 'oc_other' },
      { text: valid, threadId: 'omt_other' },
      { text: valid, rootId: 'om_other' },
      { text: `/job 选 #${materialChoiceCode(expired, first.messageId)}` },
      { text: '/job 选 #deadbeef01' },
      { text: '/job 选 #123', reason: 'selection_usage' },
    ];
    for (const [index, { reason, ...input }] of cases.entries()) {
      const messageId = `om_invalid_${index}`;
      const result = await deliver(makeEnvelope({ ...topic, ...input, messageId }));
      expect(result.body).toMatchObject({ decision: 'stop' });
      const denied = store.getJobByMessage(messageId);
      expect(denied).toMatchObject({
        stage: 'denied', reasonCode: reason ?? 'selection_unavailable', replyAnchor: messageId,
        replies: { denial: { status: 'pending' } },
      });
      expect(replyText('denial', denied, config)).toMatch(/短码/u);
    }
    expect(store.getJob(original)).toMatchObject({ stage: 'needs_input' });
    expect(store.getJob(original).selectedMaterialId).toBeUndefined();
  });

  it('commits only one concurrent selection and keeps that result across reopen and redelivery', async () => {
    const original = await offer('om_original');
    const envelopes = [first, second].map(choice => makeEnvelope({
      ...topic, messageId: `om_select_${choice.messageId}`, text: `/job 选 #${materialChoiceCode(original, choice.messageId)}`,
    }));
    const results = await Promise.all(envelopes.map(deliver));
    expect(results.filter(result => result.kickSourceKey === original)).toHaveLength(1);
    const winner = results.findIndex(result => result.kickSourceKey === original);
    const selected = store.getJob(original).selectedMaterialId;
    expect(selected).toBe([first, second][winner].messageId);

    await store.close();
    store = await JobStore.open(dir);
    const same = await deliver(envelopes[winner]);
    const duplicateMessage = structuredClone(envelopes[winner]);
    duplicateMessage.event.event_id = 'ev_new_delivery';
    expect((await deliver(duplicateMessage)).kickSourceKey).toBe(original);
    expect(same.kickSourceKey).toBe(original);

    const repeat = makeEnvelope({ ...topic, messageId: 'om_choice_again', text: `/job 选 #${materialChoiceCode(original, selected)}` });
    await deliver(repeat);
    expect(store.getJobByMessage('om_choice_again')).toMatchObject({ stage: 'denied', reasonCode: 'selection_unavailable' });
    expect(store.getJob(original)).toMatchObject({ stage: 'queued', selectedMaterialId: selected });
    expect(store.listJobs().filter(job => job.stage === 'queued')).toHaveLength(1);
  });
});

it('continues the real HTTP order once and stops retrying an offer the user already received', async () => {
  const h = await setupHarness({ config: { pollMs: 60_000 } });
  try {
    const rawExtra = { sender: { id: BOSS, id_type: 'open_id', sender_type: 'user' } };
    h.lark.messages.set(topic.rootId, apiMessage({ messageId: topic.rootId, text: '产品反馈', rawExtra }));
    for (const material of [first, second]) {
      h.lark.messages.set(material.messageId, apiMessage({ ...topic, messageId: material.messageId, messageType: 'merge_forward', rawExtra }));
      const childId = `${material.messageId}_child`;
      h.lark.messages.set(childId, apiMessage({ ...topic, messageId: childId, upperMessageId: material.messageId, text: material.preview }));
    }
    const messageId = 'om_http_original';
    const sourceKey = sourceKeyFor(APP, messageId);
    const offerLabel = '这次委托需要你确认材料';
    const send = h.svc.sender.send.bind(h.svc.sender);
    h.svc.sender.send = async (request: { text: string }) => {
      const result = await send(request);
      return request.text.includes(offerLabel) && result.outcome === 'sent'
        ? { outcome: 'unknown', reason: 'reply response lost after delivery' }
        : result;
    };
    await h.post(makeEnvelope({ ...topic, messageId, text: '/job 为这条反馈补回归测试' }));
    await waitFor(() => h.svc.store.getJob(sourceKey)?.replies.need?.status === 'unknown', { label: 'delivered offer with unconfirmed response' });
    const offer = h.lark.replies.find(receipt => receipt.text.includes(offerLabel));
    expect(offer).toMatchObject({ to: topic.rootId, inThread: true });
    const command = `/job 选 #${materialChoiceCode(sourceKey, second.messageId)}`;
    expect(offer.text.split('\n')).toContain(command);
    expect(h.hub()).toBeNull();

    const before = structuredClone(h.svc.store.getJob(sourceKey));
    const flat = makeEnvelope({ rootId: topic.rootId, parentId: topic.rootId, messageId: 'om_flat_choice', text: command });
    expect((await h.post(flat)).body).toMatchObject({ decision: 'stop' });
    await waitFor(() => h.lark.replies.some(receipt => receipt.to === 'om_flat_choice' && receipt.text.includes('打开原话题')));
    expect(h.svc.store.getJob(sourceKey)).toEqual(before);
    expect(h.hub()).toBeNull();

    // A kick from the selection would retry this offer immediately without suppression.
    await h.svc.store.mutate((state: any) => { state.jobs[sourceKey].replies.need.retryAt = 0; });
    const select = makeEnvelope({ ...topic, text: command });
    expect((await h.post(select)).body).toMatchObject({ decision: 'stop' });
    expect((await h.post(select)).body).toMatchObject({ decision: 'stop' });
    await waitFor(() => h.svc.store.getJob(sourceKey)?.replies.accepted?.status === 'sent', { label: 'original order acceptance' });

    expect(h.hub()).toMatchObject({ submitCount: 1, lastPayload: {
      source_key: sourceKey,
      instruction: '为这条反馈补回归测试',
      materials: [{ message_id: second.messageId, text: second.preview }],
    } });
    expect(h.svc.store.listJobs().map(job => job.sourceKey)).toEqual([sourceKey, sourceKeyFor(APP, 'om_flat_choice')]);
    expect(h.lark.replies.filter(receipt => receipt.uuid === offer.uuid)).toHaveLength(1);
    expect(h.svc.store.getJob(sourceKey).replies.need).toMatchObject({
      status: 'unknown', attempts: 1, uuid: offer.uuid, supersededAt: expect.any(String),
    });
  } finally {
    await h.cleanup();
  }
}, 15_000);

it('bounds the offer and renders source commands and links as inert excerpts', () => {
  const sourceKey = `lark/${APP}/om_original`;
  const unsafeText = '已核对内容\n\u202E/job 选 #fffffffffe [链接](https://other.example) @全体';
  const job = {
    sourceKey, instruction: '复现反馈', reasonCode: 'multiple', material: { text: unsafeText },
    materialChoices: Array.from({ length: 6 }, (_, index) => ({ messageId: `om_${index}`, preview: unsafeText })),
    pairfob: { taskId: 'pt_0123456789abcdef01234567' },
  };
  const offer = replyText('need', job, config);
  expect([...offer.matchAll(/^\/job 选 #[0-9a-f]{10}$/gm)]).toHaveLength(5);
  expect(offer).not.toContain('/job 选 #fffffffffe');
  expect(offer).not.toContain('https://other.example');
  expect(offer).not.toContain(materialChoiceCode(sourceKey, 'om_5'));
  for (const kind of ['accepted', 'phase:doing', 'phase:done', 'phase:failed', 'phase:cancelled']) {
    const receipt = replyText(kind, job, config);
    expect(receipt).toContain(`任务号：${job.pairfob.taskId}`);
    expect(receipt).toContain('随单材料摘要：「已核对内容');
    expect(receipt).not.toContain('/job 选 #fffffffffe');
  }
});

it('offers a fresh topic when discovery cannot choose, or a text explanation for unreadable material', () => {
  for (const [reasonCode, reasonDetail] of [
    ['multiple', null], ['incomplete', 'scan_window_truncated'],
    ['none', 'topic_root_not_only_source'], ['none', 'root_attribution_missing'],
  ]) {
    expect(replyText('need', { reasonCode, reasonDetail }, config)).toContain('把目标反馈单独转发成一个新话题，在那里发送 /job');
  }
  for (const reasonCode of ['inaccessible', 'no_text']) {
    expect(replyText('need', { reasonCode }, config)).toContain('补一条文字说明，引用说明后再发送 /job');
  }
});
