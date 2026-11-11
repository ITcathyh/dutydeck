import { describe, expect, it, vi } from 'vitest';
import { buildLarkCard, larkCardFinalOutputText, larkCardRequestBytes, larkCardSafeLimits, LarkCardService, type LarkCardInput } from './service.js';
import { patchLarkCard, sendLarkResult } from './result-delivery.js';

const samples = [
  ['quotes', '"'.repeat(10_000)],
  ['backslashes', '\\'.repeat(10_000)],
  ['controls', '\u0000\n\t\r'.repeat(4_000)],
  ['CJK', '中日한'.repeat(5_000)],
  ['emoji', '🙂🚀'.repeat(6_000)],
  ['single-line', 'a'.repeat(40_000)]
] as const;
const log = { warn: vi.fn() };
const resultInput = (text: string): LarkCardInput & { elements: Array<Record<string, any>>; idempotencyKey: string } => ({
  taskId: 'task_budget', taskName: '检查结果', cardKind: 'result', state: 'completed', readOnly: true,
  elements: [{ tag: 'markdown', element_id: 'final_output', content: text }], idempotencyKey: 'budget-result'
});
function harness(showAgentName = false) {
  const bodies: Array<{ path: string; method: string; raw: string; value: any }> = [];
  const files: Blob[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/tenant_access_token/')) return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 });
    if (url.endsWith('/images')) return Response.json({ code: 0, data: { image_key: 'img_fixture' } });
    if (url.endsWith('/files')) {
      files.push((init.body as FormData).get('file') as Blob);
      return Response.json({ code: 0, data: { file_key: 'file_fixture' } });
    }
    if (url.includes('/im/v1/messages')) {
      const raw = String(init.body);
      const value = JSON.parse(raw);
      bodies.push({ path: url, method: init.method!, raw, value });
      return Response.json({ code: 0, data: { message_id: value.msg_type === 'file' ? 'om_file' : 'om_card', chat_id: 'oc_group' } });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  const service = new LarkCardService({ appId: 'cli_budget', appSecret: 'fixture-secret', defaultReceiveIdType: 'chat_id', defaultAgentName: showAgentName ? '🙂'.repeat(64) : 'Dutydeck', showAgentName, baseUrl: 'https://open.example.com', env: { LARK_API_QPS: '10000' } }, fetcher as typeof fetch);
  return { service, bodies, files };
}

describe('ordinary card final request budget', () => {
  it.each(samples)('bounds the actual send, reply and patch JSON for %s', async (_name, text) => {
    const h = harness();
    const metadata = '\\"🙂'.repeat(500);
    const input: LarkCardInput = { state: 'completed', markdown: text, taskName: metadata, agentName: metadata, showAgentName: true, sessionId: metadata, taskId: metadata, workspace: metadata };
    await h.service.send({ ...input, receiveId: `recipient-${'x'.repeat(1500)}`, receiveIdType: 'email', idempotencyKey: 'uuid'.repeat(100) });
    await h.service.reply({ ...input, messageId: `om_${'y'.repeat(1000)}`, replyInThread: true, idempotencyKey: 'uuid'.repeat(100) });
    await h.service.update({ ...input, messageId: `om_${'y'.repeat(1000)}` });
    expect(h.bodies).toHaveLength(3);
    for (const body of h.bodies) {
      expect(Buffer.byteLength(body.raw)).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
      const { content, ...fields } = body.value;
      const card = JSON.parse(content);
      expect(larkCardRequestBytes(card, fields)).toBe(Buffer.byteLength(body.raw));
      JSON.parse(content, (_key, value) => {
        if (typeof value === 'string') expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        return value;
      });
    }
    expect(h.bodies[0]!.value).toMatchObject({ receive_id: `recipient-${'x'.repeat(1500)}`, msg_type: 'interactive' });
    expect(h.bodies[0]!.value.uuid.length).toBeLessThanOrEqual(50);
    expect(h.bodies[1]!.value.reply_in_thread).toBe(true);
    expect(Object.keys(h.bodies[2]!.value)).toEqual(['content']);
    expect(h.bodies[2]!.method).toBe('PATCH');
  });

  it('counts the second serialization that expands the 10,000-quote regression sample', () => {
    const unbounded = { body: { elements: [{ tag: 'markdown', content: '"'.repeat(10_000) }] } };
    const inner = Buffer.byteLength(JSON.stringify(unbounded));
    expect(inner).toBeLessThan(larkCardSafeLimits.bytes);
    expect(larkCardRequestBytes(unbounded)).toBeGreaterThan(larkCardSafeLimits.bytes);
    expect(larkCardRequestBytes(buildLarkCard({ state: 'completed', markdown: '"'.repeat(10_000) }))).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
  });

  it.each(samples)('keeps the full %s result in an attachment when it no longer fits', async (_name, text) => {
    const h = harness();
    const result = await sendLarkResult(h.service, { chatId: 'oc_group' }, resultInput(text), log);
    expect(result.attachmentMessageId).toBe('om_file');
    expect(h.files).toHaveLength(1);
    expect(await h.files[0]!.text()).toBe(text);
    const card = h.bodies.find(body => body.value.msg_type === 'interactive')!;
    expect(card.value.content).toContain('正文开头节选（非完整结论）');
    expect(card.value.content).toContain('完整正文已发送为附件');
    expect(Buffer.byteLength(card.raw)).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
  });

  it('uses the full attachment when actual bot decorations make a preflight-sized result overflow', async () => {
    const h = harness(true);
    const fields = { receive_id: 'oc_group', msg_type: 'interactive', reply_in_thread: true, uuid: 'x'.repeat(50) };
    let length = 5_000;
    while (larkCardFinalOutputText(buildLarkCard(resultInput('"'.repeat(length + 1)), fields).body.elements) === '"'.repeat(length + 1)) length++;
    const text = '"'.repeat(length);
    expect(larkCardFinalOutputText(buildLarkCard(resultInput(text), fields).body.elements)).toBe(text);
    const result = await sendLarkResult(h.service, { chatId: 'oc_group' }, resultInput(text), log);
    expect(result.attachmentMessageId).toBe('om_file');
    expect(await h.files[0]!.text()).toBe(text);
    const cards = h.bodies.filter(body => body.value.msg_type === 'interactive');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.value.content).toContain('完整正文已发送为附件');
  });

  it('retains approval controls when long text needs a fallback', async () => {
    const h = harness();
    await h.service.reply({ messageId: 'om_question', state: 'running', awaitingHuman: true, readOnly: true,
      elements: [{ tag: 'markdown', content: '"'.repeat(20_000) },
        { tag: 'button', element_id: 'approval', text: { tag: 'plain_text', content: '批准本次调用' }, behaviors: [{ type: 'callback', value: { request_id: 'permit_fixture', action: 'approve' } }] }]
    });
    const card = h.bodies[0]!;
    expect(Buffer.byteLength(card.raw)).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(card.value.content).toContain('批准本次调用');
    expect(card.value.content).toContain('permit_fixture');
  });

  it('refuses an oversized custom body instead of silently removing its buttons', async () => {
    const h = harness();
    await expect(h.service.reply({ messageId: 'om_question', state: 'completed', cardBody: { elements: [{ tag: 'markdown', content: '"'.repeat(20_000) }] } as any }))
      .rejects.toMatchObject({ code: 'LARK_CARD_BUDGET_EXCEEDED' });
    expect(h.bodies).toHaveLength(0);
  });

  it.each([false, true])('fails explicitly when approval controls exceed the request budget (nested=%s)', async nested => {
    const h = harness();
    const control = { tag: 'button', text: { tag: 'plain_text', content: '批准本次调用' }, behaviors: [{ type: 'callback', value: { request_id: '"'.repeat(10_000), action: 'approve' } }] };
    const elements = nested ? [{ tag: 'collapsible_panel', element_id: 'trace_group_controls', elements: [control] }] : [control];
    await expect(h.service.reply({ messageId: 'om_question', state: 'completed', elements })).rejects.toMatchObject({ code: 'LARK_CARD_BUDGET_EXCEEDED' });
    expect(h.bodies).toHaveLength(0);
  });

  it('measures patch without send fields and refuses to replace a complete result with an excerpt', async () => {
    const h = harness();
    // Find the boundary using the actual renderer so this remains valid as card decorations evolve.
    let text = '"'.repeat(5_000);
    while (larkCardFinalOutputText(buildLarkCard(resultInput(text), {}).body.elements) === text) text += '"'.repeat(50);
    const original = resultInput(text);
    expect(await patchLarkCard(h.service, { messageId: 'om_existing' }, original, log)).toBeNull();
    expect(h.bodies).toHaveLength(0);
    const small = resultInput('完整正文');
    expect(await patchLarkCard(h.service, { messageId: 'om_existing' }, small, log)).toEqual(expect.objectContaining({ messageId: 'om_card' }));
    const card = JSON.parse(h.bodies[0]!.value.content);
    expect(larkCardRequestBytes(card, { receive_id: 'oc_group', msg_type: 'interactive', uuid: 'x'.repeat(50) })).toBeGreaterThan(larkCardRequestBytes(card, {}));
  });
});
