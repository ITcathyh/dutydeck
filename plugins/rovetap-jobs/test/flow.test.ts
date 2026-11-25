import { afterEach, describe, expect, it } from 'vitest';
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

describe('rovetap-jobs  happy path / contract', () => {
  it('persists inbox, calls the real-arg-array CLI with the contract payload, replies in thread with link', async () => {
    h = await setupHarness();
    seedQuotedText();

    const res = await h.post(makeEnvelope({
      eventId: 'ev_happy', messageId: 'om_happy', parentId: 'om_fwd1', threadId: 'omt_1', rootId: 'om_root',
      text: '/job rovetap 复现并修复草稿丢失，补回归测试。',
    }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event_id: 'ev_happy', decision: 'stop' });

    await waitFor(() => h!.hub()?.submitCount === 1, { label: 'one submit' });
    const payload = h.hub().lastPayload;
    expect(payload).toMatchObject({
      source_key: `lark/${APP}/om_happy`,
      actor: { app_id: APP, open_id: BOSS },
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
    expect(accepted.text).toContain('pt_000001');
    expect(accepted.text).toContain('pl_leader_1');
    expect(accepted.text).toContain('https://rove.example.com/?task=pt_000001&leader=pl_leader_1');
  });

  it('uses the default instruction and default project for a bare /job', async () => {
    h = await setupHarness();
    seedQuotedText('om_fwd2', '材料正文');
    await h.post(makeEnvelope({ messageId: 'om_bare', parentId: 'om_fwd2', threadId: 'omt_1', rootId: 'om_root', text: '/job' }));
    await waitFor(() => h!.hub()?.submitCount === 1);
    expect(h.hub().lastPayload.instruction).toBe('请项目 leader 跟进这条反馈。');
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
  it('rejects a non-commander real user in the dispatch group: stop + denial, no order', async () => {
    h = await setupHarness();
    const res = await h.post(makeEnvelope({ eventId: 'ev_intr', messageId: 'om_intr', openId: OTHER }));
    expect(res.body.decision).toBe('stop');
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('没有') && r.text.includes('权限')));
    expect(h.hub()).toBeNull();
  });

  it('silently stops in a non-dispatch chat (no outbound, no order)', async () => {
    h = await setupHarness();
    const res = await h.post(makeEnvelope({ eventId: 'ev_chat', messageId: 'om_chat', chatId: 'oc_random' }));
    expect(res.body.decision).toBe('stop');
    await waitFor(() => h!.svc.store.getJobByMessage('om_chat')?.stage === 'denied');
    expect(h.lark.replies).toHaveLength(0);
    expect(h.hub()).toBeNull();
  });

  it('stops silently for a bot sender', async () => {
    h = await setupHarness();
    const res = await h.post(makeEnvelope({ eventId: 'ev_bot', messageId: 'om_botsender', senderType: 'app', openId: 'ou_app' }));
    expect(res.body.decision).toBe('stop');
    await waitFor(() => h!.svc.store.getJobByMessage('om_botsender')?.stage === 'denied');
    expect(h.lark.replies).toHaveLength(0);
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

describe('rovetap-jobs  material selection', () => {
  it('multiple forwards without a quote asks for an explicit quote', async () => {
    h = await setupHarness();
    h.lark.messages.set('om_mf1', apiMessage({ messageId: 'om_mf1', messageType: 'merge_forward', threadId: 'omt_multi' }));
    h.lark.messages.set('om_mf2', apiMessage({ messageId: 'om_mf2', messageType: 'merge_forward', threadId: 'omt_multi' }));
    await h.post(makeEnvelope({ messageId: 'om_multi', threadId: 'omt_multi', text: '/job 调查' }));
    await waitFor(() => h!.lark.replies.some((r) => r.text.includes('多条')));
    expect(h.hub()).toBeNull();
  });

  it('uses the single confirmable forward when there is no quote, reading merge_forward children via API', async () => {
    h = await setupHarness();
    h.lark.messages.set('om_mf_u', apiMessage({ messageId: 'om_mf_u', messageType: 'merge_forward', threadId: 'omt_u' }));
    h.lark.messages.set('om_child_u', apiMessage({
      messageId: 'om_child_u', upperMessageId: 'om_mf_u', threadId: 'omt_u', text: '唯一转发：搜索页打不开文件',
    }));
    await h.post(makeEnvelope({ messageId: 'om_unique', threadId: 'omt_u', text: '/job 跟进这条' }));
    await waitFor(() => h!.hub()?.submitCount === 1);
    const material = h.hub().lastPayload.materials[0];
    expect(material.message_id).toBe('om_mf_u');
    expect(material.text).toContain('搜索页打不开文件');
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
