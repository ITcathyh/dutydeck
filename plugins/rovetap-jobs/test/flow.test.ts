import { afterEach, describe, expect, it } from 'vitest';
import { runLarkEventPipeline, type LarkEventHandler } from '../../../apps/server/src/lark/event-pipeline.js';
import { createService } from '../service/main.mjs';
import {
  setupHarness, makeEnvelope, waitFor, apiMessage,
  APP, CHAT, BOSS, OTHER, TOKEN, type Harness,
} from './helpers/harness';

let h: Harness | undefined;
afterEach(async () => { if (h) await h.cleanup(); h = undefined; });

const seedQuotedText = (id = 'om_fwd1', text = '切回前台后草稿消失，连续两次复现。') => {
  h!.lark.messages.set(id, apiMessage({ messageId: id, text, threadId: 'omt_1', rootId: 'om_root' }));
};

const seedTopic = (threadId: string) => {
  h!.lark.messages.set('om_root', apiMessage({ messageId: 'om_root', text: '产品反馈', threadId }));
  return { threadId, rootId: 'om_root', parentId: 'om_root' };
};

describe('rovetap-jobs  happy path / contract', () => {
  it.each([
    { senderType: 'user', openId: BOSS },
    { senderType: 'app', openId: 'ou_dispatch_app' },
    { senderType: 'bot', openId: 'ou_dispatch_bot' },
  ])('submits the verified actor and replies in thread for $senderType', async ({ senderType, openId }) => {
    h = await setupHarness({ config: { commanderOpenIds: [BOSS, openId] } });
    seedQuotedText();

    const res = await h.post(makeEnvelope({
      eventId: 'ev_happy', messageId: 'om_happy', parentId: 'om_fwd1', threadId: 'omt_1', rootId: 'om_root',
      senderType, openId,
      text: '/job rovetap 复现并修复草稿丢失，补回归测试。',
    }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event_id: 'ev_happy', decision: 'stop' });
    expect(h.svc.store.getJobByMessage('om_happy')).toMatchObject({ commanderOpenId: openId, commanderSenderType: senderType });

    await waitFor(() => h!.hub()?.submitCount === 1, { label: 'one submit' });
    const payload = h.hub().lastPayload;
    expect(payload).toMatchObject({
      source_key: `lark/${APP}/om_happy`,
      actor: { app_id: APP, open_id: openId },
      thread_id: 'omt_1',
      instruction: '复现并修复草稿丢失，补回归测试。',
    });
    expect(payload.materials).toHaveLength(1);
    expect(payload.materials[0]).toEqual({ message_id: 'om_fwd1', text: expect.stringContaining('草稿消失') });

    const invocation = h.hub().invocations[0];
    expect(invocation.socket).toBe(h.config.pairfob.socket);
    expect(invocation.tokenFile).toBe(h.config.pairfob.tokenFile);

    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('项目已接单')), { label: 'accepted reply' });
    const accepted = h.lark.replies.find((r) => r.text.includes('项目已接单'));
    expect(accepted.to).toBe('om_root'); // anchored to topic root
    expect(accepted.inThread).toBe(true);
    expect(accepted.uuid).toBeTruthy();
    expect(accepted.text).toContain('任务号：pt_000001');
    expect(accepted.text).toContain('标题片段：复现并修复草稿丢失，补回归测试。');
    expect(accepted.text).toContain('在已连接总机的 RoveTap 中查看');
    expect(accepted.text).toContain('新版桌面看板优先用完整任务号');
    expect(accepted.text).toContain('其他客户端可按标题片段查找');
    expect(accepted.text).toContain('进展会回到本话题');
    expect(accepted.text).toContain('项目任务入口（仅在已连接总机的 RoveTap 环境可用）');
    expect(accepted.text).toContain('https://rove.example.com/?task=pt_000001&leader=pl_leader_1');
  });

  it('uses the default instruction and helps find a bare /job task without a web link', async () => {
    h = await setupHarness({ config: { webBaseUrl: '' } });
    seedQuotedText('om_fwd2', '材料正文');
    await h.post(makeEnvelope({ messageId: 'om_bare', parentId: 'om_fwd2', threadId: 'omt_1', rootId: 'om_root', text: '/job' }));
    await waitFor(() => h!.lark.replies.some((reply) => reply.text.includes('项目已接单')));
    expect(h.hub().lastPayload.instruction).toBe('请项目 leader 跟进这条反馈。');
    const accepted = h.lark.replies.find((reply) => reply.text.includes('项目已接单'));
    expect(accepted.text).toContain('任务号：pt_000001');
    expect(accepted.text).toContain('标题片段：请项目 leader 跟进这条反馈。');
    expect(accepted.text).toContain('新版桌面看板优先用完整任务号');
    expect(accepted.text).toContain('其他客户端可按标题片段查找');
    expect(accepted.text).not.toMatch(/https?:\/\//);
  });

  it('announces doing then done phases exactly once', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd3');
    await h.post(makeEnvelope({ messageId: 'om_phase', parentId: 'om_fwd3', threadId: 'omt_1', rootId: 'om_root' }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('项目已接单')));

    h.updateHub((hub) => { hub.keys[`lark/${APP}/om_phase`].phase = 'doing'; });
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('正在处理')), { label: 'doing' });

    h.updateHub((hub) => { hub.keys[`lark/${APP}/om_phase`].phase = 'done'; });
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('已完成')), { label: 'done' });

    // Poll a while; each phase message appears once.
    await new Promise((r) => setTimeout(r, 120));
    const doing = h.lark.replies.filter((r) => r.text.includes('正在处理'));
    const done = h.lark.replies.filter((r) => r.text.includes('已完成'));
    expect(doing).toHaveLength(1);
    expect(done).toHaveLength(1);
  });
});

describe('rovetap-jobs  deduplication / concurrency / recovery', () => {
  it('collapses repeated event_id and repeated message_id to one submit', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd_d');
    const envelope = makeEnvelope({ eventId: 'ev_dup', messageId: 'om_dup', parentId: 'om_fwd_d', threadId: 'omt_1', rootId: 'om_root' });

    const r1 = await h.post(envelope);
    const r2 = await h.post(envelope);
    const redeliveredNewEvent = makeEnvelope({ eventId: 'ev_dup2', messageId: 'om_dup', parentId: 'om_fwd_d', threadId: 'omt_1', rootId: 'om_root' });
    const r3 = await h.post(redeliveredNewEvent);
    expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
    expect([r1.body.decision, r2.body.decision, r3.body.decision]).toEqual(['stop', 'stop', 'stop']);

    await waitFor(() => h!.hub()?.submitCount === 1);
    await new Promise((r) => setTimeout(r, 120));
    expect(h.hub().submitCount).toBe(1);
  });

  it('handles concurrent identical deliveries with exactly one job', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd_c');
    const envelope = makeEnvelope({ eventId: 'ev_conc', messageId: 'om_conc', parentId: 'om_fwd_c', threadId: 'omt_1', rootId: 'om_root' });
    const results = await Promise.all(Array.from({ length: 12 }, () => h!.post(envelope)));
    expect(results.every((r) => r.status === 200 && r.body.decision === 'stop')).toBe(true);
    await waitFor(() => h!.hub()?.submitCount === 1, { timeout: 8_000 });
    await new Promise((r) => setTimeout(r, 150));
    expect(h.hub().submitCount).toBe(1);
    expect(h.svc.store.listJobs()).toHaveLength(1);
  });

  it('submit stdout loss after commit never resubmits; status by original key finds the task', async () => {
    h = await setupHarness({ mode: 'drop' });
    seedQuotedText('om_fwd_lost');
    const t0 = Date.now();
    const res = await h.post(makeEnvelope({ eventId: 'ev_lost', messageId: 'om_lost', parentId: 'om_fwd_lost', threadId: 'omt_1', rootId: 'om_root' }));
    expect(res.body.decision).toBe('stop');
    expect(Date.now() - t0).toBeLessThan(1_500); // receipt not blocked by CLI

    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('项目已接单') && r.text.includes('pt_')), { label: 'reconciled accepted' });
    expect(h.hub().submitCount).toBe(1);
    expect(h.hub().statusCalls).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.hub().submitCount).toBe(1); // never re-issued
  });

  it('recovers phase polling after a process restart from persisted state', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd_restart');
    await h.post(makeEnvelope({ eventId: 'ev_restart', messageId: 'om_restart', parentId: 'om_fwd_restart', threadId: 'omt_1', rootId: 'om_root' }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('项目已接单')));

    // Leader advanced phase while the adapter was "down".
    h.updateHub((hub) => { hub.keys[`lark/${APP}/om_restart`].phase = 'doing'; });
    await h.svc.stop();

    const svc2 = await createService(h.config, { logger: { info() {}, warn() {}, error() {}, debug() {} } });
    try {
      await waitFor(() => h!.lark.replies.some((r) => r.text.includes('正在处理')), { label: 'post-restart doing' });
      // Exactly one persisted job survived.
      expect(svc2.store.listJobs()).toHaveLength(1);
    } finally {
      await svc2.stop();
    }
  });

  it('retries an uncertain outbound reply with the SAME durable uuid', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd_uuid');
    h.lark.failReplies = 1; // first /reply -> synthetic 500 (unknown)
    await h.post(makeEnvelope({ messageId: 'om_uuid', parentId: 'om_fwd_uuid', threadId: 'omt_1', rootId: 'om_root' }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('项目已接单')), { timeout: 6_000 });

    const replyCalls = h.lark.requests.filter((r) => r.path.endsWith('/reply'));
    const uuids = replyCalls.map((r) => r.body.uuid);
    expect(uuids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(uuids).size).toBe(1); // same idempotency key across retry
  });
});

describe('rovetap-jobs  authorization and rejection', () => {
  it.each([
    { senderType: 'app', chatType: 'group' },
    { senderType: 'bot', chatType: 'topic_group' },
  ])('dispatches from an unlisted $senderType in an enabled $chatType', async ({ senderType, chatType }) => {
    h = await setupHarness({ config: { allowAllBotCommanders: true, commanderOpenIds: [] } });
    seedQuotedText();
    const res = await h.post(makeEnvelope({
      messageId: 'om_group_bot', senderType, chatType, openId: 'ou_group_bot',
      text: '@_user_1 /job rovetap 检查反馈材料', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      parentId: 'om_fwd1', threadId: 'omt_1', rootId: 'om_root',
    }));
    expect(res.body.decision).toBe('stop');
    await waitFor(() => h!.lark.replies.some(reply => reply.inThread && reply.to === 'om_root' && reply.text.includes('项目已接单')));
    expect(h.hub()).toMatchObject({ submitCount: 1, lastPayload: {
      actor: { app_id: APP, open_id: 'ou_group_bot' },
      materials: [{ message_id: 'om_fwd1', text: '切回前台后草稿消失，连续两次复现。' }],
    } });
  });

  it.each([undefined, true])('rejects a non-commander user when allowAllBotCommanders=%s', async allowAllBotCommanders => {
    h = await setupHarness({ config: { allowAllBotCommanders } });
    const res = await h.post(makeEnvelope({ eventId: 'ev_intr', messageId: 'om_intr', openId: OTHER }));
    expect(res.body.decision).toBe('stop');
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('没有') && r.text.includes('权限')));
    expect(h.hub()).toBeNull();
  });

  it.each(['user', 'app', 'bot'])('silently stops an authorized %s in a non-dispatch chat', async (senderType) => {
    h = await setupHarness({ config: { allowAllBotCommanders: true } });
    const res = await h.post(makeEnvelope({ eventId: 'ev_chat', messageId: 'om_chat', chatId: 'oc_random', senderType }));
    expect(res.body.decision).toBe('stop');
    const denied = h.svc.store.getJobByMessage('om_chat');
    expect(denied).toMatchObject({ stage: 'denied', reasonCode: 'chat_not_allowed' });
    expect(denied.replies).toEqual({});
    expect(h.lark.replies).toHaveLength(0);
    expect(h.hub()).toBeNull();
  });

  it('requires a group event to authorize an unlisted bot', async () => {
    h = await setupHarness({ config: { allowAllBotCommanders: true } });
    const res = await h.post(makeEnvelope({ messageId: 'om_private_bot', senderType: 'app', chatType: 'p2p', openId: OTHER }));
    expect(res.body.decision).toBe('stop');
    expect(h.svc.store.getJobByMessage('om_private_bot')).toMatchObject({ stage: 'denied', reasonCode: 'forbidden' });
    expect(h.hub()).toBeNull();
  });

  it.each([
    { senderType: 'app', allowAllBotCommanders: undefined },
    { senderType: 'bot', allowAllBotCommanders: false },
  ])('silently stops an unlisted $senderType when allowAllBotCommanders=$allowAllBotCommanders', async ({ senderType, allowAllBotCommanders }) => {
    h = await setupHarness({ config: { allowAllBotCommanders } });
    const res = await h.post(makeEnvelope({
      eventId: 'ev_bot', messageId: 'om_botsender', senderType, openId: 'ou_unlisted_bot',
      text: '/job rovetap 请 @_user_1 看这条反馈。',
      mentions: [{ key: '@_user_1', id: { open_id: BOSS } }],
    }));
    expect(res.body.decision).toBe('stop');
    const denied = h.svc.store.getJobByMessage('om_botsender');
    expect(denied).toMatchObject({ stage: 'denied', reasonCode: 'forbidden' });
    expect(denied.replies).toEqual({});
    expect(h.lark.replies).toHaveLength(0);
    expect(h.hub()).toBeNull();
  });

  it.each([
    { senderType: 'app', openId: '' },
    { senderType: 'bot', openId: ' ' },
    { senderType: 'system', openId: BOSS },
  ])('silently rejects $senderType with an invalid sender identity', async (sender) => {
    h = await setupHarness({ config: { allowAllBotCommanders: true } });
    const res = await h.post(makeEnvelope({ messageId: 'om_invalid_sender', ...sender }));
    expect(res.body.decision).toBe('stop');
    const denied = h.svc.store.getJobByMessage('om_invalid_sender');
    expect(denied).toMatchObject({ stage: 'denied', reasonCode: 'invalid_sender' });
    expect(denied.replies).toEqual({});
    expect(h.lark.replies).toHaveLength(0);
    expect(h.hub()).toBeNull();
  });

  it('rejects bad bearer with 401 and mismatched outer app with 403', async () => {
    h = await setupHarness();
    const bad = await h.post(makeEnvelope(), { authorization: 'Bearer wrong' });
    expect(bad.status).toBe(401);
    const noHeader = await h.post(makeEnvelope(), { authorization: '' });
    expect(noHeader.status).toBe(401);
    const mismatch = await h.post(makeEnvelope({ outerAppId: 'cli_evil' }));
    expect(mismatch.status).toBe(403);
    expect(h.svc.store.listJobs()).toHaveLength(0);
  });

  it('continues ordinary (non-/job) messages and never turns them into tasks', async () => {
    h = await setupHarness();
    const res = await h.post(makeEnvelope({ eventId: 'ev_plain', messageId: 'om_plain', text: '今天晚饭吃什么' }));
    expect(res.body.decision).toBe('continue');
    expect(h.svc.store.listJobs()).toHaveLength(0);
    expect(h.hub()).toBeNull();
  });

  it('stops and explains an unknown @project token', async () => {
    h = await setupHarness();
    const res = await h.post(makeEnvelope({ eventId: 'ev_proj', messageId: 'om_proj', text: '/job @other-team do x' }));
    expect(res.body.decision).toBe('stop');
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('rovetap')));
    expect(h.hub()).toBeNull();
  });
});

it('routes only new unlisted bot commands through the supplemental HTTP handler', async () => {
  const cutoff = Date.UTC(2026, 10, 26, 3, 4, 0);
  const listedBot = 'ou_listed_bot';
  const additionalBot = 'ou_additional_bot';
  const commanderOpenIds = [BOSS, listedBot];
  h = await setupHarness({ config: { commanderOpenIds } });
  const supplemental = await setupHarness({
    config: { commanderOpenIds, allowAllBotCommanders: true, additionalBotCommandsSince: cutoff },
  });
  try {
    const eventType = 'im.message.receive_v1';
    const handler = (id: string, svc: Harness): LarkEventHandler => ({ id, url: svc.svc.url, token: TOKEN, eventTypes: [eventType] });
    const pipelineConfig = { appId: APP, eventHandlers: [handler('supplemental', supplemental), handler('primary', h)] };
    const material = apiMessage({ messageId: 'om_material', text: '材料正文', threadId: 'omt_1', rootId: 'om_root' });
    for (const service of [h, supplemental]) service.lark.messages.set('om_material', material);
    const command = { senderType: 'app', openId: additionalBot, createTime: String(cutoff), parentId: 'om_material', threadId: 'omt_1', rootId: 'om_root' };
    const send = async (fields: Record<string, unknown>) => {
      const audits: unknown[] = [];
      const { event } = makeEnvelope({ ...command, ...fields });
      await runLarkEventPipeline(pipelineConfig, eventType, event, fetch, { info: entry => audits.push(entry) });
      return audits;
    };
    const handledBy = (handlerId: string, result: string) => expect.objectContaining({ handlerId, result });

    const fresh = { messageId: 'om_new_bot', eventId: 'ev_new_bot' };
    expect(await send(fresh)).toEqual([handledBy('supplemental', 'stop')]);
    expect(await send(fresh)).toEqual([handledBy('supplemental', 'stop')]);
    expect(await send({ ...fresh, eventId: 'ev_new_bot_retry' })).toEqual([handledBy('supplemental', 'stop')]);

    const primaryCommands = [
      { messageId: 'om_listed_bot', openId: listedBot },
      { messageId: 'om_user', senderType: 'user', openId: BOSS },
      { messageId: 'om_old_bot', createTime: String(cutoff - 1) },
      { messageId: 'om_undated_bot', messageExtra: { create_time: undefined, createTime: cutoff } },
      { messageId: 'om_invalid_time', createTime: `${cutoff}ms` },
      { messageId: 'om_invalid_actor', openId: '' },
      { messageId: 'om_other_group', chatId: 'oc_other' },
    ];
    for (const fields of primaryCommands) {
      expect(await send(fields)).toEqual([handledBy('supplemental', 'continue'), handledBy('primary', 'stop')]);
    }
    expect(await send({ messageId: 'om_receipt', text: '✅ RoveTap 项目已接单' })).toEqual([
      handledBy('supplemental', 'continue'), handledBy('primary', 'continue'),
    ]);
    const unauthorized = await supplemental.post(makeEnvelope(command), { authorization: 'Bearer wrong' });
    expect(unauthorized.status).toBe(401);

    await waitFor(() => h!.hub()?.submitCount === 2 && supplemental.hub()?.submitCount === 1);
    expect(supplemental.hub().lastPayload).toMatchObject({
      source_key: `lark/${APP}/om_new_bot`, actor: { app_id: APP, open_id: additionalBot },
    });
    expect(supplemental.svc.store.listJobs().map(job => job.messageId)).toEqual(['om_new_bot']);
    expect(h.svc.store.listJobs().map(job => job.messageId)).toEqual(primaryCommands.map(fields => fields.messageId));
    expect(h.svc.store.getJobByMessage('om_old_bot')).toMatchObject({ stage: 'denied', reasonCode: 'forbidden' });
  } finally {
    await supplemental.cleanup();
  }
});

describe('rovetap-jobs  material selection', () => {
  it('multiple forwards without a quote asks for an explicit quote', async () => {
    h = await setupHarness();
    for (const id of ['om_mf1', 'om_mf2']) {
      h.lark.messages.set(id, apiMessage({ messageId: id, messageType: 'merge_forward', threadId: 'omt_multi' }));
      h.lark.messages.set(`${id}_child`, apiMessage({ messageId: `${id}_child`, upperMessageId: id, text: '转发正文' }));
    }
    await h.post(makeEnvelope({ messageId: 'om_multi', ...seedTopic('omt_multi'), text: '/job 调查' }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('多条')));
    expect(h.hub()).toBeNull();
  });

  it('uses the single confirmable forward when there is no quote, reading merge_forward children via API', async () => {
    h = await setupHarness();
    h.lark.messages.set('om_mf_u', apiMessage({ messageId: 'om_mf_u', messageType: 'merge_forward', threadId: 'omt_u' }));
    h.lark.messages.set('om_child_u', apiMessage({
      messageId: 'om_child_u', upperMessageId: 'om_mf_u', threadId: 'omt_u', text: '唯一转发：搜索页打不开文件',
    }));
    await h.post(makeEnvelope({ messageId: 'om_unique', ...seedTopic('omt_u'), text: '/job 跟进这条' }));
    await waitFor(() => h!.hub()?.submitCount === 1);
    const material = h.hub().lastPayload.materials[0];
    expect(material.message_id).toBe('om_mf_u');
    expect(material.text).toContain('搜索页打不开文件');
  });

  it('persists the real event message.create_time as the command time anchor', async () => {
    h = await setupHarness();
    h.lark.messages.set('om_mf_t', apiMessage({ messageId: 'om_mf_t', messageType: 'merge_forward', threadId: 'omt_tanchor' }));
    h.lark.messages.set('om_child_t', apiMessage({
      messageId: 'om_child_t', upperMessageId: 'om_mf_t', threadId: 'omt_tanchor', text: '时间锚点材料正文',
    }));
    await h.post(makeEnvelope({
      eventId: 'ev_ctime', messageId: 'om_ctime', ...seedTopic('omt_tanchor'),
      createTime: '1764000060000',
    }));
    await waitFor(() => h!.svc.store.getJobByMessage('om_ctime')?.commandCreateTime === '1764000060000');
    // The persisted anchor is what lets the older candidate pass the time gate.
    await waitFor(() => h!.hub()?.submitCount === 1);
  });

  it('does not green-light a forward posted AFTER the command: asks for a quote and never submits', async () => {
    h = await setupHarness();
    // Command at T0, candidate one minute later (the "late-arriving material").
    h.lark.messages.set('om_mf_late', apiMessage({
      messageId: 'om_mf_late', messageType: 'merge_forward', threadId: 'omt_late', createTime: '1764000060000',
    }));
    h.lark.messages.set('om_child_late', apiMessage({
      messageId: 'om_child_late', upperMessageId: 'om_mf_late', threadId: 'omt_late', text: '命令之后才转发的内容',
    }));
    await h.post(makeEnvelope({
      eventId: 'ev_late', messageId: 'om_late', ...seedTopic('omt_late'), createTime: '1764000000000', text: '/job 跟进',
    }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('晚于')), { label: 'late-forward guidance' });
    expect(h.hub()).toBeNull();
    const job = h.svc.store.getJobByMessage('om_late');
    expect(job.stage).toBe('needs_input');
    expect(job.reasonDetail).toBe('no_forward_before_command');
  });

  it('asks for a quote when the command time cannot be proven end to end', async () => {
    h = await setupHarness();
    h.lark.messages.set('om_mf_undated_cmd', apiMessage({ messageId: 'om_mf_undated_cmd', messageType: 'merge_forward', threadId: 'omt_uc' }));
    // No create_time on the inbound event; the fake Lark has no om_uc_cmd
    // record to read back, so the anchor is definitively undatable.
    const envelope = makeEnvelope({ messageId: 'om_uc_cmd', ...seedTopic('omt_uc') });
    delete (envelope.event.message as any).create_time;
    await h.post(envelope);
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('无法证明')), { label: 'undatable guidance' });
    expect(h.hub()).toBeNull();
    expect(h.svc.store.getJobByMessage('om_uc_cmd')?.reasonDetail).toBe('command_time_unknown');
  });

  it('no forward at all asks the user to forward or quote', async () => {
    h = await setupHarness();
    await h.post(makeEnvelope({ messageId: 'om_none', threadId: 'omt_empty', text: '/job' }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('没有找到')));
    expect(h.hub()?.submitCount ?? 0).toBe(0);
  });

  it('rejects a cross-chat quoted reference without creating an order', async () => {
    h = await setupHarness();
    h.lark.messages.set('om_external', apiMessage({ messageId: 'om_external', chatId: 'oc_external', text: '隔壁群的秘密' }));
    await h.post(makeEnvelope({ messageId: 'om_cross', parentId: 'om_external', text: '/job' }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('不属于当前群') || r.text.includes('重新引用')));
    expect(h.hub()).toBeNull();
  });
});

describe('rovetap-jobs  command addressing: only bare /job or a real self @mention', () => {
  it('starts for an event mention whose open_id matches configured selfOpenId', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd_selfat', '材料正文');
    const res = await h.post(makeEnvelope({
      eventId: 'ev_selfat', messageId: 'om_selfat',
      parentId: 'om_fwd_selfat', threadId: 'omt_1', rootId: 'om_root',
      text: '@_user_1 /job rovetap 处理这个',
      mentions: [{ key: '@_user_1', name: 'RoveTapJobs', id: { open_id: 'ou_bot' } }],
    }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event_id: 'ev_selfat', decision: 'stop' });
    await waitFor(() => h!.hub()?.submitCount === 1, { label: 'self-mention submit' });
    expect(h.hub().lastPayload.instruction).toBe('处理这个');
  });

  it('continues without any job for messages not addressed to this bot', async () => {
    h = await setupHarness();
    const cases: Array<{ label: string; patch: Record<string, unknown> }> = [
      {
        label: 'leading real mention of another person',
        patch: {
          text: '@_user_1 /job do it',
          mentions: [{ key: '@_user_1', name: '张三', id: { open_id: 'ou_zhang' } }],
        },
      },
      {
        label: 'placeholder key authenticated as another bot',
        patch: {
          text: '@_user_1 /job do it',
          mentions: [{ key: '@_user_1', name: 'OtherBot', id: { open_id: 'ou_other_bot' } }],
        },
      },
      { label: 'forged placeholder with no event mentions', patch: { text: '@_user_1 /job do it' } },
      { label: 'literal bot-looking name as plain text', patch: { text: '@RoveTapJobs /job do it' } },
      { label: 'slash look-alike /job/foo', patch: { text: '/job/foo' } },
      { label: 'punctuation-glued /job,do', patch: { text: '/job,do' } },
      { label: 'merge_forward content carrying /job', patch: { messageType: 'merge_forward', content: '{"title":"合并转发 /job x"}' } },
      { label: 'image message', patch: { messageType: 'image', content: '{"image_key":"k"}' } },
      { label: 'rich-text post containing /job', patch: { messageType: 'post', content: JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: '/job do it' }]] } }) } },
      { label: 'text with explicit forward_from provenance', patch: { text: '/job do it', messageExtra: { forward_from: 'om_old_forward' } } },
      { label: 'text with forward descriptor object', patch: { text: '/job do it', messageExtra: { forward: { sender_open_id: 'ou_x' } } } },
    ];

    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      const res = await h.post(makeEnvelope({
        eventId: `ev_addr_${i}`, messageId: `om_addr_${i}`,
        parentId: undefined, threadId: undefined, rootId: undefined,
        ...c.patch,
      }));
      expect(res.body, c.label).toMatchObject({ decision: 'continue' });
    }
    expect(h.svc.store.listJobs()).toHaveLength(0);
    expect(h.hub()).toBeNull();
  });
});

describe('rovetap-jobs  instruction length is counted in Unicode code points', () => {
  it('rejects 4001 code points with an explicit limit hint and creates no order', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd_len', '材料');
    const longInstruction = '指'.repeat(4001);
    await h.post(makeEnvelope({
      eventId: 'ev_len_too_long', messageId: 'om_len_long', parentId: 'om_fwd_len', threadId: 'omt_1', rootId: 'om_root',
      text: `/job rovetap ${longInstruction}`,
    }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('指令过长') && r.text.includes('4000')), {
      label: 'explicit length hint',
    });
    expect(h.hub()).toBeNull();
    expect(h.svc.store.getJobByMessage('om_len_long')?.reasonCode).toBe('instruction_too_long');
  });

  it('counts astral characters as one code point each: 2500 emoji (5000 UTF-16 units) is accepted', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd_astral', '材料');
    const emojiInstruction = '😀'.repeat(2500);
    await h.post(makeEnvelope({
      eventId: 'ev_len_astral', messageId: 'om_len_astral', parentId: 'om_fwd_astral', threadId: 'omt_1', rootId: 'om_root',
      text: `/job rovetap ${emojiInstruction}`,
    }));
    await waitFor(() => h!.hub()?.submitCount === 1, { label: 'one submit by code-point rule' });
    expect(Array.from(h.hub().lastPayload.instruction).length).toBe(2500);
  });
});
