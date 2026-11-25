import { describe, expect, it } from 'vitest';
import {
  resolveMaterial, verifyScope, verifiedText, clipToCodePoints,
  isForwardCandidate, textBodyProblem, ROVE_ENTRY_CODEPOINTS,
} from '../service/materials.mjs';
import { normalizeMessage } from '../service/lark-api.mjs';

// ---- fixtures ---------------------------------------------------------------

let seq = 0;
function msg(over: Record<string, any> = {}): any {
  seq += 1;
  const messageId = over.messageId ?? `om_${seq}`;
  return {
    messageId,
    chatId: 'oc_dispatch',
    threadId: null,
    rootId: null,
    parentId: null,
    upperMessageId: null,
    messageType: 'text',
    createTime: '1764000000000',
    deleted: false,
    sender: null,
    content: JSON.stringify({ text: `正文 ${seq}` }),
    raw: {},
    ...over,
  };
}

function textMsg(messageId: string, text: string, over: Record<string, any> = {}): any {
  return msg({ messageId, content: JSON.stringify({ text }), ...over });
}

function mfMsg(messageId: string, over: Record<string, any> = {}): any {
  return msg({ messageId, messageType: 'merge_forward', content: JSON.stringify({}), ...over });
}

interface FakeOptions {
  /** id -> items returned by getMessageItems; missing id behaves like API not_found. */
  items?: Map<string, any[]>;
  /** Simpler single-record table; getMessageItems returns [record] unless children given. */
  records?: Map<string, any>;
  children?: Map<string, any[]>;
  errors?: Record<string, any>;
  pages?: any[];
  listImpl?: (q: any) => any;
}

function fakeClient(opts: FakeOptions = {}) {
  const calls: { get: string[]; list: any[] } = { get: [], list: [] };
  const notFound = (id: string) => Object.assign(new Error(`not found ${id}`), { kind: 'not_found' });
  const client = {
    calls,
    async getMessageItems(id: string) {
      calls.get.push(id);
      if (opts.errors?.[id]) throw opts.errors[id];
      if (opts.items?.has(id)) return opts.items.get(id);
      const record = opts.records?.get(id);
      if (!record && id === 'om_root') return [msg({ messageId: id, messageType: 'image', createTime: '1' })];
      if (!record) throw notFound(id);
      return [record, ...(opts.children?.get(id) ?? [])];
    },
    async listMessages(q: any) {
      calls.list.push(q);
      if (opts.listImpl) return opts.listImpl(q);
      if (opts.pages && opts.pages.length) return opts.pages.shift();
      return { items: [], hasMore: false, pageToken: null };
    },
  };
  return client;
}

const event = (over: Record<string, any> = {}) => ({
  chatId: 'oc_dispatch',
  threadId: 'omt_topic',
  rootId: 'om_root',
  parentId: null,
  messageId: 'om_command',
  // Mirrors the command message.create_time the handler now persists; the msg()
  // fixture's default createTime is one minute earlier.
  createTime: '1764000060000',
  ...over,
});

const notFoundError = Object.assign(new Error('gone'), { kind: 'not_found' });
const networkError = Object.assign(new Error('reset'), { kind: 'network' });

// ---- explicit quote scope ---------------------------------------------------

describe('materials / explicit reference scope', () => {
  it('accepts a parent in the same chat and same thread', async () => {
    const parent = textMsg('om_p', '崩溃复现步骤', { threadId: 'omt_topic', rootId: 'om_root' });
    const client = fakeClient({ records: new Map([['om_p', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_p' }) });
    expect(r.status).toBe('ok');
    expect(r.material.messageId).toBe('om_p');
    expect(r.material.text).toContain('崩溃复现步骤');
  });

  it('accepts same chat + same root even when the parent carries no thread id', async () => {
    const parent = textMsg('om_p', 'root only', { threadId: null, rootId: 'om_root' });
    const client = fakeClient({ records: new Map([['om_p', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_p' }) });
    expect(r.status).toBe('ok');
  });

  it('accepts the sole earlier topic root even without thread/root attribution on the item', async () => {
    const root = textMsg('om_root', '话题根原文', { threadId: null, rootId: null });
    const client = fakeClient({ records: new Map([['om_root', root]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_root' }) });
    expect(r.status).toBe('ok');
    expect(r.material.text).toContain('话题根原文');
  });

  it('accepts a plain same-chat parent when the command has no topic', async () => {
    const parent = textMsg('om_p', '群里的引用', { threadId: null, rootId: null });
    const client = fakeClient({ records: new Map([['om_p', parent]]) });
    const r = await resolveMaterial({
      client,
      event: event({ threadId: null, rootId: null, parentId: 'om_p' }),
    });
    expect(r.status).toBe('ok');
  });

  it('rejects a cross-chat reference', async () => {
    const parent = textMsg('om_x', '隔壁群秘密', { chatId: 'oc_other' });
    const client = fakeClient({ records: new Map([['om_x', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_x' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'cross_scope', detail: 'chat_mismatch' });
  });

  it('rejects a fetched parent missing chat attribution', async () => {
    const parent = textMsg('om_x', '无群归属', { chatId: null });
    const client = fakeClient({ records: new Map([['om_x', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_x' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'cross_scope', detail: 'chat_attribution_missing' });
  });

  it('rejects a different thread and a different root', async () => {
    const otherThread = textMsg('om_a', '别的话题', { threadId: 'omt_other', rootId: 'om_other_root' });
    const c1 = fakeClient({ records: new Map([['om_a', otherThread]]) });
    await expect(resolveMaterial({ client: c1, event: event({ parentId: 'om_a' }) }))
      .resolves.toMatchObject({ status: 'need', reason: 'cross_scope' });

    const sameThreadOtherRoot = textMsg('om_b', 'root 不一致', { threadId: null, rootId: 'om_shadow' });
    const c2 = fakeClient({ records: new Map([['om_b', sameThreadOtherRoot]]) });
    await expect(resolveMaterial({ client: c2, event: event({ parentId: 'om_b' }) }))
      .resolves.toMatchObject({ status: 'need', reason: 'cross_scope', detail: 'topic_mismatch' });
  });

  it('rejects a topic-scoped parent missing all topic attribution', async () => {
    const parent = textMsg('om_p', '归属缺失', { threadId: null, rootId: null });
    const client = fakeClient({ records: new Map([['om_p', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_p' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'cross_scope', detail: 'topic_attribution_missing' });
  });

  it('verifyScope is fail-closed on a null target', () => {
    expect(verifyScope(null, event()).ok).toBe(false);
  });
});

// ---- deletion / read-back / placeholders ------------------------------------

describe('materials / deleted, unreadable and placeholder bodies', () => {
  it('rejects a deleted referenced message', async () => {
    const parent = textMsg('om_del', '已撤回', { deleted: true, threadId: 'omt_topic' });
    const client = fakeClient({ records: new Map([['om_del', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_del' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'inaccessible', detail: 'deleted' });
  });

  it('asks for a quote when the referenced id is not returned by read-back', async () => {
    const client = fakeClient({ items: new Map([['om_p', []]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_p' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'inaccessible', detail: 'reference_not_readable' });
  });

  it('maps not_found/forbidden read errors to need-quote but keeps network errors retryable', async () => {
    const c1 = fakeClient({ errors: { om_p: notFoundError } });
    await expect(resolveMaterial({ client: c1, event: event({ parentId: 'om_p' }) }))
      .resolves.toMatchObject({ status: 'need', reason: 'inaccessible' });

    const forbidden = Object.assign(new Error('forbidden'), { kind: 'forbidden' });
    const c2 = fakeClient({ errors: { om_p: forbidden } });
    await expect(resolveMaterial({ client: c2, event: event({ parentId: 'om_p' }) }))
      .resolves.toMatchObject({ status: 'need', reason: 'inaccessible' });

    const c3 = fakeClient({ errors: { om_p: networkError } });
    await expect(resolveMaterial({ client: c3, event: event({ parentId: 'om_p' }) }))
      .resolves.toMatchObject({ status: 'error' });

    // Exhausted client-side rate limiting stays transient for worker backoff,
    // distinct from a permanent forbidden/not_found quote request.
    const rateLimited = Object.assign(new Error('429'), { kind: 'rate_limited' });
    const c4 = fakeClient({ errors: { om_p: rateLimited } });
    await expect(resolveMaterial({ client: c4, event: event({ parentId: 'om_p' }) }))
      .resolves.toMatchObject({ status: 'error' });
  });

  it('rejects a body made only of literal mention placeholders', async () => {
    for (const body of ['@_user_1', '  @_user_1 @_user_2 ', '@_all']) {
      const parent = textMsg('om_ph', body, { threadId: 'omt_topic' });
      const client = fakeClient({ records: new Map([['om_ph', parent]]) });
      const r = await resolveMaterial({ client, event: event({ parentId: 'om_ph' }) });
      expect(r).toMatchObject({ status: 'need', reason: 'no_text', detail: 'mention_placeholder' });
    }
  });

  it('rejects the literal merge_forward API placeholder body', async () => {
    const parent = textMsg('om_lit', 'Merged and Forwarded Message', { threadId: 'omt_topic' });
    const client = fakeClient({ records: new Map([['om_lit', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_lit' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'no_text', detail: 'literal_placeholder' });
  });

  it('keeps real text that merely contains a mention placeholder', async () => {
    const parent = textMsg('om_ok', '@_user_1 这个必现，请看日志', { threadId: 'omt_topic' });
    const client = fakeClient({ records: new Map([['om_ok', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_ok' }) });
    expect(r.status).toBe('ok');
    expect(r.material.text).toContain('这个必现');
  });

  it('textBodyProblem classifies empty and null', () => {
    expect(textBodyProblem('   ')).toBe('empty');
    expect(textBodyProblem(null)).toBe('empty');
    expect(textBodyProblem('真实内容')).toBeNull();
  });

  it('normalizeMessage maps the deleted flag from OpenAPI items', () => {
    expect(normalizeMessage({ message_id: 'om_a', deleted: true }).deleted).toBe(true);
    expect(normalizeMessage({ message_id: 'om_b' }).deleted).toBe(false);
  });
});

// ---- merge_forward children -------------------------------------------------

describe('materials / merge_forward parent-child verification', () => {
  it('reads only children whose upperMessageId proves the relation', async () => {
    const parent = mfMsg('om_mf', { threadId: 'omt_topic', rootId: 'om_root' });
    const realChild = textMsg('om_c1', '子项一', { upperMessageId: 'om_mf' });
    const unrelated = textMsg('om_stranger', '没有父子归属的条目', { upperMessageId: null });
    const wrongUpper = textMsg('om_c2', '挂在别的合并转发下', { upperMessageId: 'om_other_mf' });
    const items = new Map([['om_mf', [parent, realChild, unrelated, wrongUpper]]]);
    const client = fakeClient({ items });

    const r = await resolveMaterial({ client, event: event({ parentId: 'om_mf' }) });
    expect(r.status).toBe('ok');
    expect(r.material.text).toContain('子项一');
    expect(r.material.text).not.toContain('没有父子归属');
    expect(r.material.text).not.toContain('别的合并转发');
  });

  it('reads relation-proven children even when they originated in another chat', async () => {
    const parent = mfMsg('om_mf', { threadId: 'omt_topic', rootId: 'om_root' });
    const crossChatChild = textMsg('om_c1', '来自原私聊的反馈', {
      upperMessageId: 'om_mf', chatId: 'oc_origin_private', threadId: null, rootId: null,
    });
    const client = fakeClient({ items: new Map([['om_mf', [parent, crossChatChild]]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_mf' }) });
    expect(r.status).toBe('ok');
    expect(r.material.text).toContain('来自原私聊的反馈');
  });

  it('excludes deleted and placeholder-only children', () => {
    const parent = mfMsg('om_mf');
    const good = textMsg('om_c1', '有效正文', { upperMessageId: 'om_mf' });
    const deleted = textMsg('om_c2', '已删除子项', { upperMessageId: 'om_mf', deleted: true });
    const ph = textMsg('om_c3', '@_user_1', { upperMessageId: 'om_mf' });
    const text = verifiedText(parent, [parent, good, deleted, ph], 4000);
    expect(text).toContain('有效正文');
    expect(text).not.toContain('已删除子项');
    expect(text).not.toContain('@_user_1');
  });

  it('returns empty text when relation yields no readable child', async () => {
    const parent = mfMsg('om_mf', { threadId: 'omt_topic' });
    const stranger = textMsg('om_x', '无关系');
    const client = fakeClient({ items: new Map([['om_mf', [parent, stranger]]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_mf' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'no_text', detail: 'empty' });
  });
});

// ---- no-reference discovery -------------------------------------------------

describe('materials / unique-forward discovery inside the topic only', () => {
  it('uses the single merge_forward candidate of the current omt_ topic', async () => {
    const candidate = mfMsg('om_mf_u', { threadId: 'omt_topic' });
    const child = textMsg('om_child', '唯一转发正文', { upperMessageId: 'om_mf_u' });
    const client = fakeClient({
      records: new Map([['om_mf_u', candidate]]),
      children: new Map([['om_mf_u', [child]]]),
      pages: [{ items: [candidate], hasMore: false }],
    });
    const r = await resolveMaterial({ client, event: event() });
    expect(r.status).toBe('ok');
    expect(r.material.messageId).toBe('om_mf_u');
    expect(r.material.text).toContain('唯一转发正文');
    expect(client.calls.list[0].containerIdType).toBe('thread');
  });

  it('without an omt_ topic asks for a quote and never lists any container', async () => {
    for (const threadId of [null, undefined, 'om_root']) {
      const client = fakeClient();
      const r = await resolveMaterial({
        client,
        event: event({ threadId, rootId: 'om_root' }),
      });
      expect(r).toMatchObject({ status: 'need', reason: 'none', detail: 'no_topic' });
      expect(client.calls.list).toHaveLength(0);
    }
  });

  it('never issues a chat-wide list request', async () => {
    const candidate = mfMsg('om_mf_u', { threadId: 'omt_topic' });
    const client = fakeClient({
      records: new Map([['om_mf_u', candidate]]),
      pages: [{ items: [candidate], hasMore: false }],
    });
    await resolveMaterial({ client, event: event() });
    expect(client.calls.list.every((q) => q.containerIdType === 'thread')).toBe(true);
  });

  it('an unreadable sole root needs text; several earlier forwards need a choice', async () => {
    const empty = fakeClient({ pages: [{ items: [], hasMore: false }] });
    await expect(resolveMaterial({ client: empty, event: event() }))
      .resolves.toMatchObject({ status: 'need', reason: 'no_text' });

    const many = ['om_mf1', 'om_mf2'].map((id) => mfMsg(id, { threadId: 'omt_topic', sender: { sender_type: 'user' } }));
    const items = new Map(many.map((m) => [
      m.messageId, [m, textMsg(`${m.messageId}_child`, '转发正文', { upperMessageId: m.messageId })],
    ]));
    const multi = fakeClient({ items, pages: [{ items: many, hasMore: false }] });
    await expect(resolveMaterial({ client: multi, event: event() }))
      .resolves.toMatchObject({
        status: 'need', reason: 'multiple', candidateCount: 2,
        choices: many.map((m) => ({ messageId: m.messageId, preview: '转发正文' })),
      });
  });

  it('retries a failed detail read instead of losing the material choices', async () => {
    const sender = { sender_type: 'user' };
    const first = mfMsg('om_first', { threadId: 'omt_topic', sender });
    const second = mfMsg('om_second', { threadId: 'omt_topic', sender });
    const pages = () => ({ items: [first, second], hasMore: false });
    const items = new Map([
      [first.messageId, [first, textMsg('om_first_child', '先转发的原文', { upperMessageId: first.messageId })]],
      [second.messageId, [second, textMsg('om_second_child', '后转发的原文', { upperMessageId: second.messageId })]],
    ]);
    const errors = { om_second: networkError as Error | undefined };
    const client = fakeClient({ items, errors, listImpl: pages });
    await expect(resolveMaterial({ client, event: event() })).resolves.toMatchObject({ status: 'error' });
    errors.om_second = undefined;
    await expect(resolveMaterial({ client, event: event() })).resolves.toMatchObject({
      status: 'need', reason: 'multiple',
      choices: [
        { messageId: first.messageId, preview: '先转发的原文' },
        { messageId: second.messageId, preview: '后转发的原文' },
      ],
    });
  });

  it('does not dispatch an earlier merge forward when a plausible reply cannot be verified', async () => {
    const forward = mfMsg('om_forward', { threadId: 'omt_topic' });
    const reply = textMsg('om_feedback', '列表里的另一条反馈', { threadId: 'omt_topic' });
    const client = fakeClient({
      items: new Map([[forward.messageId, [forward, textMsg('om_child', '合并转发', { upperMessageId: forward.messageId })]]]),
      pages: [{ items: [forward, reply], hasMore: false }],
    });
    const result = await resolveMaterial({ client, event: event() });
    expect(result).toMatchObject({ status: 'need', reason: 'inaccessible' });
    expect(result).not.toHaveProperty('choices');
  });

  it('only merge_forward is a confirmable forward candidate', () => {
    expect(isForwardCandidate(mfMsg('a'))).toBe(true);
    expect(isForwardCandidate(msg({ messageType: 'text', raw: { forward: true } }))).toBe(false);
    expect(isForwardCandidate(msg({ messageType: 'text', raw: { forward_from: 'ou_x' } }))).toBe(false);
    expect(isForwardCandidate(msg({ messageType: 'text', raw: { origin: { message_id: 'om_o' } } }))).toBe(false);
    expect(isForwardCandidate(msg({ messageType: 'text' }))).toBe(false);
    expect(isForwardCandidate(null)).toBe(false);
  });

  it('asks for a quote when has_more is true without a page token', async () => {
    const client = fakeClient({ pages: [{ items: [mfMsg('om_mf1')], hasMore: true, pageToken: null }] });
    const r = await resolveMaterial({ client, event: event() });
    expect(r).toMatchObject({ status: 'need', reason: 'incomplete', detail: 'bad_page_token' });
  });

  it('never uses a text root from an incomplete or malformed topic page', async () => {
    const root = textMsg('om_root', '产品反馈');
    const client = fakeClient({
      records: new Map([['om_root', root]]),
      pages: [{ items: [] }], // The API did not prove this was the last page.
    });
    const result = await resolveMaterial({ client, event: event({ parentId: 'om_root' }) });
    expect(result).toEqual({ status: 'need', reason: 'incomplete', detail: 'malformed_page' });
  });

  it('drains continuation pages and accepts a unique candidate on a later page', async () => {
    const candidate = mfMsg('om_mf_late', { threadId: 'omt_topic' });
    const child = textMsg('om_late_c', '晚页里的转发正文', { upperMessageId: 'om_mf_late' });
    const client = fakeClient({
      records: new Map([['om_mf_late', candidate]]),
      children: new Map([['om_mf_late', [child]]]),
      pages: [
        { items: [textMsg('om_receipt', '接单回执', { sender: { sender_type: 'app' } })], hasMore: true, pageToken: 'pt1' },
        { items: [candidate], hasMore: false, pageToken: null },
      ],
    });
    const r = await resolveMaterial({ client, event: event(), scanLimit: 30 });
    expect(r.status).toBe('ok');
    expect(r.material.messageId).toBe('om_mf_late');
    expect(client.calls.list).toHaveLength(2);
    expect(client.calls.list[1].pageToken).toBe('pt1');
  });

  it('scan budget exhausted with older pages left -> incomplete rather than guessing unique', async () => {
    const client = fakeClient({
      listImpl: async () => ({ items: [mfMsg('om_mf1'), mfMsg('om_mf2')], hasMore: true, pageToken: 'ptX' }),
    });
    const r = await resolveMaterial({ client, event: event(), scanLimit: 2 });
    expect(r).toMatchObject({ status: 'need', reason: 'incomplete', detail: 'scan_window_truncated' });
  });

  it('re-fetched candidate missing or cross-scoped is rejected, with no list-object fallback', async () => {
    const candidate = mfMsg('om_mf_u');
    const missing = fakeClient({
      items: new Map([['om_mf_u', []]]),
      pages: [{ items: [candidate], hasMore: false }],
    });
    await expect(resolveMaterial({ client: missing, event: event() }))
      .resolves.toMatchObject({ status: 'need', reason: 'inaccessible', detail: 'candidate_detail_missing' });

    const cross = mfMsg('om_mf_u', { chatId: 'oc_other' });
    const other = fakeClient({
      records: new Map([['om_mf_u', cross]]),
      pages: [{ items: [candidate], hasMore: false }],
    });
    await expect(resolveMaterial({ client: other, event: event() }))
      .resolves.toMatchObject({ status: 'need', reason: 'cross_scope' });
  });

  it('never fetches ids of mentioned accounts or anything except reference/candidate/anchor', async () => {
    const candidate = mfMsg('om_mf_u', {
      raw: { mentions: [{ id: { open_id: 'ou_mentioned_user' } }] },
    });
    const client = fakeClient({
      records: new Map([['om_mf_u', candidate]]),
      pages: [{ items: [candidate], hasMore: false }],
    });
    await resolveMaterial({ client, event: event() });
    for (const id of client.calls.get) {
      expect(id.startsWith('om_')).toBe(true);
      expect(id).not.toBe('ou_mentioned_user');
    }
  });
});

// ---- only candidates before the command --------------------------------------

describe('materials / candidates must predate the command', () => {
  it('excludes a forward posted after the command', async () => {
    const newer = mfMsg('om_after', { createTime: '3000' });
    const client = fakeClient({ pages: [{ items: [newer], hasMore: false }] });
    const r = await resolveMaterial({ client, event: event({ createTime: '2000' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'none', detail: 'no_forward_before_command' });
  });

  it('keeps only the older forward when one older and one newer compete', async () => {
    const older = mfMsg('om_old', { createTime: '1000' });
    const newer = mfMsg('om_new', { createTime: '3000' });
    const chosen = mfMsg('om_old', { threadId: 'omt_topic', createTime: '1000' });
    const child = textMsg('om_old_c', '旧转发正文', { upperMessageId: 'om_old' });
    const client = fakeClient({
      records: new Map([['om_old', chosen]]),
      children: new Map([['om_old', [child]]]),
      pages: [{ items: [newer, older], hasMore: false }],
    });
    const r = await resolveMaterial({ client, event: event({ createTime: '2000' }) });
    expect(r.status).toBe('ok');
    expect(r.material.messageId).toBe('om_old');
  });

  it('uses the command anchor found in the listed page for its time', async () => {
    const command = msg({ messageId: 'om_command', messageType: 'text', createTime: '2000' });
    const older = mfMsg('om_old', { createTime: '1000' });
    const chosen = mfMsg('om_old', { threadId: 'omt_topic', createTime: '1000' });
    const child = textMsg('om_old_c2', '旧转发正文二', { upperMessageId: 'om_old' });
    const client = fakeClient({
      records: new Map([['om_old', chosen]]),
      children: new Map([['om_old', [child]]]),
      pages: [{ items: [command, older], hasMore: false }],
    });
    const r = await resolveMaterial({ client, event: event({ createTime: null }) });
    expect(r.status).toBe('ok');
    expect(r.material.messageId).toBe('om_old');
    // Anchor came from the list: no direct command read-back needed.
    expect(client.calls.get).not.toContain('om_command');
  });

  it('reads the command anchor by id when absent from the list', async () => {
    const older = mfMsg('om_old', { createTime: '1000' });
    const chosen = mfMsg('om_old', { threadId: 'omt_topic', createTime: '1000' });
    const child = textMsg('om_old_c3', '旧转发正文三', { upperMessageId: 'om_old' });
    const command = msg({ messageId: 'om_command', createTime: '2000' });
    const client = fakeClient({
      records: new Map([['om_old', chosen], ['om_command', command]]),
      children: new Map([['om_old', [child]]]),
      pages: [{ items: [older], hasMore: false }],
    });
    const r = await resolveMaterial({ client, event: event({ createTime: null }) });
    expect(r.status).toBe('ok');
    expect(client.calls.get).toContain('om_command');
  });

  it('retries on a transient anchor read failure instead of deciding', async () => {
    const older = mfMsg('om_old', { createTime: '1000' });
    const client = fakeClient({
      errors: { om_command: networkError },
      pages: [{ items: [older], hasMore: false }],
    });
    const r = await resolveMaterial({ client, event: event({ createTime: null }) });
    expect(r).toMatchObject({ status: 'error' });
  });

  it('asks for a quote when the command anchor is definitively undatable, even with one candidate', async () => {
    const only = mfMsg('om_only', { threadId: 'omt_topic' });
    const child = textMsg('om_only_c', '唯一转发正文', { upperMessageId: 'om_only' });
    const client = fakeClient({
      records: new Map([['om_only', only]]),
      children: new Map([['om_only', [child]]]),
      errors: { om_command: notFoundError },
      pages: [{ items: [only], hasMore: false }],
    });
    const r = await resolveMaterial({ client, event: event({ createTime: null }) });
    expect(r).toMatchObject({ status: 'need', reason: 'incomplete', detail: 'command_time_unknown' });
    // Fail closed before re-fetching/trusting the candidate.
    expect(client.calls.get).not.toContain('om_only');
  });

  it('asks for a quote when the event carries no command time and no anchor id exists', async () => {
    const only = mfMsg('om_only2', { threadId: 'omt_topic' });
    const client = fakeClient({ pages: [{ items: [only], hasMore: false }] });
    const r = await resolveMaterial({ client, event: event({ createTime: null, messageId: null }) });
    expect(r).toMatchObject({ status: 'need', reason: 'incomplete', detail: 'command_time_unknown' });
  });

  it('asks for a quote when a candidate time cannot be ordered against a known command time', async () => {
    const undated = mfMsg('om_undated', { createTime: null });
    const client = fakeClient({ pages: [{ items: [undated], hasMore: false }] });
    const r = await resolveMaterial({ client, event: event({ createTime: '2000' }) });
    expect(r).toMatchObject({ status: 'need', reason: 'incomplete', detail: 'candidate_time_unknown' });
  });
});

// ---- 4000 Unicode code point limit ------------------------------------------

describe('materials / Rove 4000 code point submission limit', () => {
  it('exports the Rove contract constant', () => {
    expect(ROVE_ENTRY_CODEPOINTS).toBe(4000);
  });

  it('clips by code point without splitting astral characters', () => {
    const body = '😀'.repeat(5000); // each emoji is one code point / two UTF-16 units
    const out = clipToCodePoints(body, 4000);
    expect(Array.from(out).length).toBeLessThanOrEqual(4000);
    expect(() => encodeURIComponent(out)).not.toThrow();
    // Head is whole emoji; suffix is appended within budget.
    expect(out.endsWith('已截断）')).toBe(true);
    const suffixLength = Array.from('\n…（材料过长，已截断）').length;
    expect(Array.from(out).filter((c) => c === '😀').length).toBe(4000 - suffixLength);
  });

  it('keeps the truncation marker within a small configured limit', () => {
    expect(Array.from(clipToCodePoints('😀'.repeat(10), 2))).toHaveLength(2);
  });

  it('never exceeds 4000 code points even when caller asks for more', async () => {
    const longText = '码'.repeat(20_000);
    const parent = textMsg('om_long', longText, { threadId: 'omt_topic' });
    const client = fakeClient({ records: new Map([['om_long', parent]]) });
    const r = await resolveMaterial({ client, event: event({ parentId: 'om_long' }), maxChars: 20_000 });
    expect(r.status).toBe('ok');
    expect(Array.from(r.material.text).length).toBe(4000);
  });

  it('leaves short text untouched', () => {
    expect(clipToCodePoints('短', 4000)).toBe('短');
  });
});
