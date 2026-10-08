import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { AgentEvent } from '@dutydeck/shared';
import { loadLarkTaskEvents, renderLarkProcessElements, renderLarkResultElements } from './card-renderer.js';
import { deliverLarkStatusReaction, larkResultKey, patchLarkCard, sendLarkFile, sendLarkResult } from './result-delivery.js';
import { COMPLETION_REACTION_EMOJI, FAILURE_REACTION_EMOJI, reactionDedupeKey } from './reaction-records.js';
import { buildLarkCard, LarkCardService, LarkServiceError } from './service.js';
import { sendTaskCard } from './coordinator-core.js';

const event = (sequence: number, type: AgentEvent['type'], data: any): AgentEvent => ({
  id: `e${sequence}`, sessionId: 'ses_1', sequence, type, data, timestamp: '2026-09-08T00:00:00Z'
});
const log = { warn: vi.fn() };
const input = (text: string) => ({ state: 'completed' as const, taskId: 'task1', readOnly: true,
  elements: renderLarkResultElements([event(1, 'text', { text })]), idempotencyKey: larkResultKey('om_process') });
// 与 service.ts request() 抛出的真实形态一致：业务码和上游 HTTP 状态都在 details 里。
const openApiError = (code: number | undefined, status = 400) => new LarkServiceError('LARK_OPENAPI_ERROR',
  `Lark OpenAPI request failed: rejected (code: ${code ?? 'HTTP_ERROR'})`, 502, { upstreamCode: code, upstreamHttpStatus: status });
const recalled = () => openApiError(230011);
const table = (n: number) => `| 项 | 值 |\n| --- | --- |\n| 第 ${n} 项 | ${n} |`;
const tableCount = (value: unknown) => (JSON.stringify(value).match(/\| --- \| --- \|/g) ?? []).length;
const unknownOutcomes = () => [
  ['超时', new DOMException('The operation timed out.', 'TimeoutError')],
  ['无状态网络错误', new LarkServiceError('LARK_NETWORK_ERROR', 'Lark OpenAPI request failed: socket hang up', 502)],
  ['5xx', openApiError(undefined, 503)],
  ['230049 消息正在发送', openApiError(230049)],
  ['请求预算耗尽', new LarkServiceError('LARK_REQUEST_BUDGET_EXHAUSTED', '飞书请求的总尝试预算已用尽，等待持久化对账重投。', 503)]
] as const;

describe('separate process and complete result messages', () => {
  it('keeps completed process panels expandable even when the old hide setting is enabled', () => {
    const events = [
      event(1, 'thinking', { text: 'private reasoning' }),
      event(2, 'text', { text: '检查测试结果' }),
      event(3, 'tool_call', { id: 't1', name: 'Bash', input: { command: 'pnpm test' }, status: 'running' }),
      event(4, 'tool_result', { id: 't1', output: '125 passed', status: 'completed' }),
      event(5, 'text', { text: '完整执行结论' })
    ];
    const elements = renderLarkProcessElements(events, { hideTraceOnComplete: true }, true);
    const card = buildLarkCard({ state: 'completed', elements });
    const trace: any = card.body.elements.find(element => element.element_id === 'trace_overview');
    expect(trace).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(JSON.stringify(trace)).toContain('125 passed');
    expect(JSON.stringify(card)).toContain('已完成');
    expect(JSON.stringify(card)).not.toContain('完整执行结论');
    expect(JSON.stringify(card)).not.toContain('private reasoning');
    const result = renderLarkResultElements(events);
    expect(result.find(element => element.element_id === 'final_output')?.content).toBe('完整执行结论');
    expect(JSON.stringify(result)).not.toContain('125 passed');
    expect(JSON.stringify(result)).not.toContain('private reasoning');
  });

  it('long multi-paragraph results fold on the card and still count as fully delivered, without an attachment', async () => {
    const text = Array.from({ length: 10 }, (_, index) => `## 第 ${index + 1} 部分\n\n${'结论的展开说明。'.repeat(20)}`).join('\n\n');
    let sent: any;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (_url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
      sent = JSON.parse(JSON.parse(String(init.body)).content);
      return Response.json({ code: 0, data: { message_id: 'om_result' } });
    });
    const service = new LarkCardService({ appId: 'cli_test', appSecret: 'test', defaultReceiveIdType: 'chat_id', defaultAgentName: 'test', baseUrl: 'https://open.feishu.cn' }, fetch as any);
    const result = await sendLarkResult(service, { chatId: 'oc_group' }, input(text), log);
    expect(result).toMatchObject({ messageId: 'om_result' });
    expect(result.attachmentMessageId).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    const all = (value: any): any[] => Array.isArray(value) ? value.flatMap(all)
      : value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(all)] : [];
    const byId = (id: string) => all(sent.body.elements).find(item => item.element_id === id);
    expect(byId('final_output_more')).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(byId('final_output').content + byId('final_output_rest').content).toBe(text);
    expect(JSON.stringify(sent)).not.toContain('result_attachment');
  });

  it('sends more than 6000 characters intact through the real card service', async () => {
    const text = `BEGIN\n${'a'.repeat(7000)}\nEND`;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (_url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
      const body = JSON.parse(String(init.body));
      const card = JSON.parse(body.content);
      expect(body).toMatchObject({ msg_type: 'interactive', uuid: larkResultKey('om_process') });
      expect(card.body.elements.find((element: any) => element.element_id === 'final_output')?.content).toBe(text);
      return Response.json({ code: 0, data: { message_id: 'om_result' } });
    });
    const service = new LarkCardService({ appId: 'cli_test', appSecret: 'test', defaultReceiveIdType: 'chat_id', defaultAgentName: 'test', baseUrl: 'https://open.feishu.cn' }, fetch as any);
    const result = await sendLarkResult(service, { chatId: 'oc_group' }, input(text), log);
    expect(result.messageId).toBe('om_result');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('delivers oversized Unicode intact with a named summary, mention and existing acceptance controls', async () => {
    const text = `尚待用户扫码，创建尚未完成。\n${'完整结果🙂'.repeat(5000)}\n末尾`;
    const service = { uploadFile: vi.fn(async (_input: any) => 'file_full'), replyFile: vi.fn(async (_input: any) => ({ messageId: 'om_file' })),
      reply: vi.fn(async (_input: any) => ({ messageId: 'om_summary' })), send: vi.fn(), sendFile: vi.fn() };
    const original = input(text);
    original.elements.push({ tag: 'markdown', element_id: 'group_mention', content: '<at id=ou_owner></at>' },
      { tag: 'button', element_id: 'workflow_accept', text: { tag: 'plain_text', content: '验收通过' } });
    const result = await sendLarkResult(service as any, { chatId: 'oc_group', replyMessageId: 'om_question', replyInThread: true },
      { ...original, taskName: '创建机器人', turn: 1 }, log);
    const uploaded = Buffer.from(service.uploadFile.mock.calls[0]![0].data).toString('utf8');
    expect(uploaded).toBe(`${text}\n\n---\n\n结果验收：回复本文件消息「验收通过」即可确认；需要修改时，回复本文件消息并说明修改要求。`);
    expect(service.uploadFile.mock.calls[0]![0].filename).toBe('创建机器人.md');
    expect(service.replyFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_question', replyInThread: true, fileKey: 'file_full' }));
    expect(service.reply).toHaveBeenCalledOnce();
    const summary = service.reply.mock.calls[0]![0];
    expect(summary.idempotencyKey).not.toBe(service.replyFile.mock.calls[0]![0].idempotencyKey);
    const card = buildLarkCard(summary);
    expect(card.header.title.content).toBe('创建机器人');
    // 通知预览是结论第一句（节选卡取节选里的第一句），不是「状态 · 任务名」。
    expect(card.config.summary.content).toBe('尚待用户扫码，创建尚未完成');
    expect(JSON.stringify(card)).toContain('尚待用户扫码，创建尚未完成。');
    expect(JSON.stringify(card)).toContain('正文开头节选（非完整结论）');
    expect(JSON.stringify(card)).toContain('workflow_accept');
    expect(JSON.stringify(card)).toContain('<at id=');
    const attachmentIndex = summary.elements.findIndex((e: any) => e.element_id === 'result_attachment');
    const mentionIndex = summary.elements.findIndex((e: any) => e.element_id === 'group_mention');
    expect(mentionIndex).toBeGreaterThan(attachmentIndex);
    expect(summary.elements.at(-1)?.element_id).toBe('group_mention');
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(24 * 1024);
    expect(result).toMatchObject({ messageId: 'om_summary', attachmentMessageId: 'om_file', elements: summary.elements });
    expect(service.send).not.toHaveBeenCalled();
    expect(service.sendFile).not.toHaveBeenCalled();
  });

  it('keeps the context hint on the summary card when an oversized result moves into the attachment', async () => {
    const service = { uploadFile: vi.fn(async (_input: any) => 'file_full'), replyFile: vi.fn(async (_input: any) => ({ messageId: 'om_file' })),
      reply: vi.fn(async (_input: any) => ({ messageId: 'om_summary' })), send: vi.fn(), sendFile: vi.fn() };
    const elements = renderLarkResultElements([
      event(1, 'status', { state: 'usage', used: 180_000, size: 200_000 }),
      event(2, 'text', { text: `结论开头\n${'完整结果'.repeat(8000)}` })
    ]);
    const result = await sendLarkResult(service as any, { chatId: 'oc_group', replyMessageId: 'om_question' },
      { state: 'completed', taskId: 'task1', readOnly: true, taskName: '长结果', elements, idempotencyKey: larkResultKey('om_process') }, log);
    expect(result.attachmentMessageId).toBe('om_file');
    const summary = service.reply.mock.calls[0]![0];
    expect(summary.elements.map((element: any) => element.element_id)).toEqual(['final_output', 'result_attachment', 'context_hint']);
    expect(JSON.stringify(buildLarkCard(summary))).toContain('上下文已用 90%，可用 /new --handoff 带交接开新会话。');
  });

  it('uses the same result UUID for reply fallback and propagates a failed delivery', async () => {
    const service = { reply: vi.fn(async () => { throw recalled(); }), send: vi.fn(async () => { throw new Error('unavailable'); }) };
    await expect(sendLarkResult(service as any, { chatId: 'oc_group', replyMessageId: 'om_question' }, input('答案'), log)).rejects.toThrow('unavailable');
    expect(service.reply.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey: larkResultKey('om_process') });
    expect(service.send.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey: larkResultKey('om_process'), chatId: 'oc_group' });
    expect(larkResultKey('om_next_process')).not.toBe(larkResultKey('om_process'));
  });

  it('reply/send/fallback 卡一律强制 cardKind=result，即使调用方未设置或误传', async () => {
    const service = {
      reply: vi.fn(async () => ({ messageId: 'om_reply' })),
      send: vi.fn(async () => ({ messageId: 'om_send' }))
    };
    await expect(sendLarkResult(service as any, { chatId: 'oc_group' }, { ...input('答案'), cardKind: undefined }, log)).resolves.toMatchObject({ messageId: 'om_send' });
    expect(service.send.mock.calls[0]![0]).toMatchObject({ cardKind: 'result' });
    await expect(sendLarkResult(service as any, { chatId: 'oc_group', replyMessageId: 'om_question' }, { ...input('答案'), cardKind: 'process' as any }, log)).resolves.toMatchObject({ messageId: 'om_reply' });
    expect(service.reply.mock.calls[0]![0]).toMatchObject({ cardKind: 'result' });
  });

  it('does not replace a rejected result with a misleading delivered placeholder', async () => {
    const error = new LarkServiceError('LARK_OPENAPI_ERROR', 'rejected', 502, { upstreamCode: 230028 });
    const service = { send: vi.fn(async () => { throw error; }), uploadFile: vi.fn() };
    await expect(sendLarkResult(service as any, { chatId: 'oc_group' }, input('答案'), log)).rejects.toBe(error);
    expect(service.send).toHaveBeenCalledOnce();
    expect(service.uploadFile).not.toHaveBeenCalled();
  });

  it.each(unknownOutcomes())('does not turn a reply into a new group message when the outcome is unknown: %s', async (_label, error) => {
    const service = { reply: vi.fn(async () => { throw error; }), send: vi.fn(async () => ({ messageId: 'om_duplicate' })) };
    await expect(sendLarkResult(service as any, { chatId: 'oc_group', replyMessageId: 'om_question' }, input('答案'), log)).rejects.toBe(error);
    expect(service.reply).toHaveBeenCalledOnce();
    expect(service.send).not.toHaveBeenCalled();
  });

  it('does not change endpoint when the platform rejects a reply for another reason', async () => {
    const error = openApiError(230002);
    const service = { reply: vi.fn(async () => { throw error; }), send: vi.fn(async () => ({ messageId: 'om_group' })) };
    await expect(sendLarkResult(service as any, { chatId: 'oc_group', replyMessageId: 'om_question' }, input('答案'), log)).rejects.toBe(error);
    expect(service.send).not.toHaveBeenCalled();
  });

  it('moves a result with more tables than one card allows into the .md attachment', async () => {
    const text = ['结论：六张对比表。', ...Array.from({ length: 6 }, (_, index) => table(index + 1))].join('\n\n');
    const service = { uploadFile: vi.fn(async (_input: any) => 'file_tables'), sendFile: vi.fn(async (_input: any) => ({ messageId: 'om_file' })),
      send: vi.fn(async (_input: any) => ({ messageId: 'om_summary' })) };
    const result = await sendLarkResult(service as any, { chatId: 'oc_group' }, input(text), log);
    expect(result).toMatchObject({ messageId: 'om_summary', attachmentMessageId: 'om_file' });
    expect(Buffer.from(service.uploadFile.mock.calls[0]![0].data).toString('utf8')).toBe(text);
    const card = buildLarkCard(service.send.mock.calls[0]![0]);
    expect(JSON.stringify(card)).toContain('正文开头节选（非完整结论）');
    expect(JSON.stringify(card)).toContain('result_attachment');
  });

  it('moves a result into the attachment when one Markdown component would hold more than four tables', async () => {
    const text = ['五张表：', ...Array.from({ length: 5 }, (_, index) => table(index + 1))].join('\n\n');
    expect(text.length).toBeLessThan(800);
    const service = { uploadFile: vi.fn(async (_input: any) => 'file_tables'), sendFile: vi.fn(async (_input: any) => ({ messageId: 'om_file' })),
      send: vi.fn(async (_input: any) => ({ messageId: 'om_summary' })) };
    const result = await sendLarkResult(service as any, { chatId: 'oc_group' }, input(text), log);
    expect(result.attachmentMessageId).toBe('om_file');
    expect(service.uploadFile).toHaveBeenCalledOnce();
  });

  it('keeps five tables on the card when the opening and folded parts each hold at most four', async () => {
    const text = [`开头说明${'。'.repeat(100)}`, table(1), table(2), table(3), `中段说明${'，'.repeat(300)}`,
      table(4), table(5), `结尾说明${'；'.repeat(300)}`].join('\n\n');
    const service = { uploadFile: vi.fn(), sendFile: vi.fn(), send: vi.fn(async (_input: any) => ({ messageId: 'om_result' })) };
    const result = await sendLarkResult(service as any, { chatId: 'oc_group' }, input(text), log);
    expect(result.attachmentMessageId).toBeUndefined();
    expect(service.uploadFile).not.toHaveBeenCalled();
    const all = (value: any): any[] => Array.isArray(value) ? value.flatMap(all)
      : value && typeof value === 'object' ? [value, ...Object.values(value).flatMap(all)] : [];
    const elements = all(buildLarkCard(service.send.mock.calls[0]![0]).body.elements);
    const head = elements.find(item => item.element_id === 'final_output');
    const rest = elements.find(item => item.element_id === 'final_output_rest');
    expect([tableCount(head.content), tableCount(rest.content)]).toEqual([3, 2]);
    expect(head.content + rest.content).toBe(text);
  });

  it('rewrites image syntax whose target is not an uploaded img_ key, keeping the stored result and code intact', async () => {
    const text = ['截图如下：', '![截图](https://example.com/a.png)', '![本地图](./shots/a.png)', '![](img_v3_uploaded)',
      '```md\n![代码里](https://example.com/b.png)\n```', '行内 `![行内](c.png)` 保留'].join('\n\n');
    const service = { uploadFile: vi.fn(), sendFile: vi.fn(), send: vi.fn(async (_input: any) => ({ messageId: 'om_result' })) };
    const result = await sendLarkResult(service as any, { chatId: 'oc_group' }, input(text), log);
    expect(result.attachmentMessageId).toBeUndefined();
    expect(service.uploadFile).not.toHaveBeenCalled();
    const shown = buildLarkCard(service.send.mock.calls[0]![0]).body.elements.find((item: any) => item.element_id === 'final_output') as any;
    expect(shown.content).toBe(['截图如下：', '[截图](https://example.com/a.png)', '本地图', '![](img_v3_uploaded)',
      '```md\n![代码里](https://example.com/b.png)\n```', '行内 `![行内](c.png)` 保留'].join('\n\n'));
    // 落库的结果元素（验收重绘、显式最终答复的收据校验都读它）仍是原文。
    expect(result.elements.find(item => item.element_id === 'final_output')?.content).toBe(text);
  });

  it.each([230099, 230025])('falls back to the attachment exactly once when the platform rejects the result card with %s', async code => {
    const cards: any[] = [];
    let rejectCards = 1;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
      if (url.includes('/im/v1/files')) return Response.json({ code: 0, data: { file_key: 'file_full' } });
      const body = JSON.parse(String(init.body));
      if (body.msg_type === 'file') return Response.json({ code: 0, data: { message_id: 'om_file' } });
      cards.push(body);
      if (rejectCards-- > 0) return Response.json({ code, msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: table number over limit' }, { status: 400 });
      return Response.json({ code: 0, data: { message_id: 'om_summary' } });
    });
    const service = new LarkCardService({ appId: 'cli_degrade', appSecret: 'test', defaultReceiveIdType: 'chat_id', defaultAgentName: 'test', baseUrl: 'https://open.feishu.cn' }, fetch as any);
    const result = await sendLarkResult(service, { chatId: 'oc_group' }, input('一段平台拒收的结论'), log);
    expect(result).toMatchObject({ messageId: 'om_summary', attachmentMessageId: 'om_file' });
    expect(cards).toHaveLength(2);
    expect(cards[1].uuid).not.toBe(cards[0].uuid);
    expect(cards[1].uuid.length).toBeLessThanOrEqual(50);
    expect(cards[1].content).toContain('result_attachment');

    // 降级后的节选卡也被拒收：不再降第二次，交给对账按错误类型处理。
    cards.length = 0; rejectCards = 2;
    await expect(sendLarkResult(service, { chatId: 'oc_group' }, { ...input('另一段结论'), idempotencyKey: larkResultKey('om_other') }, log))
      .rejects.toMatchObject({ details: { upstreamCode: code } });
    expect(cards).toHaveLength(2);
  });

  it('loads the complete task when a streamed answer exceeds the recent event window', async () => {
    const events = [event(1, 'text', { role: 'user', taskId: 'task1', text: '问题' }),
      ...Array.from({ length: 1600 }, (_, index) => event(index + 2, 'text', { text: `${index}\n` })),
      event(1602, 'task', { task: { id: 'task1', status: 'completed' } }),
      event(1603, 'text', { role: 'user', taskId: 'task2', text: '另一轮问题' }),
      event(1604, 'text', { text: '另一轮结果' })];
    const runtime = { getRecentEvents: vi.fn(async (_id: string, limit: number) => events.slice(-limit)) };
    const loaded = await loadLarkTaskEvents(runtime, 'ses_1', 'task1', 500);
    const result = renderLarkResultElements(loaded).find(element => element.element_id === 'final_output');
    expect(result?.content).toBe(Array.from({ length: 1600 }, (_, index) => `${index}`).join('\n'));
    expect(runtime.getRecentEvents.mock.calls.map(call => call[1])).toEqual([500, 1000, 2000]);
    expect(JSON.stringify(result)).not.toContain('另一轮');
  });
});

describe('回复失败后是否改为会话内新发', () => {
  const groupEvent = { messageId: 'om_trigger', chatId: 'oc_group', chatType: 'group', messageType: 'text', content: '{}', mentions: [] };

  it('task cards fall back to a group message only when the trigger message can no longer be replied to', async () => {
    const service = { reply: vi.fn(async () => { throw recalled(); }), send: vi.fn(async (_input: any) => ({ messageId: 'om_group' })) };
    await expect(sendTaskCard(service as any, groupEvent, { state: 'running', idempotencyKey: 'task_om_trigger_1' }, log)).resolves.toMatchObject({ messageId: 'om_group' });
    expect(service.send.mock.calls[0]![0]).toMatchObject({ chatId: 'oc_group', idempotencyKey: 'task_om_trigger_1' });
  });

  it.each(unknownOutcomes())('task cards keep the reply endpoint when the outcome is unknown: %s', async (_label, error) => {
    const service = { reply: vi.fn(async () => { throw error; }), send: vi.fn(async () => ({ messageId: 'om_duplicate' })) };
    await expect(sendTaskCard(service as any, groupEvent, { state: 'running', idempotencyKey: 'task_om_trigger_1' }, log)).rejects.toBe(error);
    expect(service.send).not.toHaveBeenCalled();
  });

  it('file replies fall back with the same UUID only for an unavailable trigger, never after a timeout', async () => {
    const make = (error: Error) => ({ uploadFile: vi.fn(async () => 'file_key'), replyFile: vi.fn(async () => { throw error; }),
      sendFile: vi.fn(async (_input: any) => ({ messageId: 'om_file' })) });
    const gone = make(recalled());
    await expect(sendLarkFile(gone as any, { chatId: 'oc_group', replyMessageId: 'om_trigger' }, { data: new Uint8Array([1]), filename: 'a.md', idempotencyKey: 'file_uuid' }, log))
      .resolves.toMatchObject({ messageId: 'om_file' });
    expect(gone.sendFile.mock.calls[0]![0]).toMatchObject({ chatId: 'oc_group', idempotencyKey: 'file_uuid' });
    const timeout = new DOMException('The operation timed out.', 'TimeoutError');
    const unknown = make(timeout);
    await expect(sendLarkFile(unknown as any, { chatId: 'oc_group', replyMessageId: 'om_trigger' }, { data: new Uint8Array([1]), filename: 'a.md', idempotencyKey: 'file_uuid' }, log))
      .rejects.toBe(timeout);
    expect(unknown.sendFile).not.toHaveBeenCalled();
  });
});

describe('patchLarkCard 整卡 PATCH 与回退判定', () => {
  const cardInput = (elements: Array<Record<string, unknown>>) => ({ state: 'running' as const, taskId: 'task1',
    readOnly: true, elements, idempotencyKey: 'patch-key' });

  it('整卡覆盖被点击消息并回传 messageId', async () => {
    const update = vi.fn(async (input: any) => ({ messageId: input.messageId }));
    const result = await patchLarkCard({ update } as any, { messageId: 'om_clicked' }, cardInput([{ tag: 'markdown', content: '最新状态' }]), log);
    expect(result).toEqual({ messageId: 'om_clicked' });
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![0]).toMatchObject({ messageId: 'om_clicked' });
    const body = JSON.stringify(update.mock.calls[0]![0]);
    expect(body).toContain('最新状态');
  });

  it('最终结果超出卡片预算时不做 PATCH，交调用方回退发新卡', async () => {
    const update = vi.fn(async () => ({ messageId: 'om_clicked' }));
    const elements = [{ tag: 'markdown', element_id: 'final_output', content: 'x'.repeat(30_000) }];
    await expect(patchLarkCard({ update } as any, { messageId: 'om_clicked' }, cardInput(elements), log)).resolves.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('平台 PATCH 失败时记录告警并返回 null', async () => {
    const update = vi.fn(async () => { throw new Error('message too old'); });
    await expect(patchLarkCard({ update } as any, { messageId: 'om_old' }, cardInput([{ tag: 'markdown', content: '状态' }]), log)).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_old' }), expect.any(String));
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('durable multi-message result delivery', () => {
  it('reopens SQLite after summary failure and sends only the missing summary, then replays both receipts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-result-restart-'));
    let repos = createRepositories(join(dir, 'state.db'));
    cleanups.push(async () => { repos.close(); await rm(dir, { recursive: true, force: true }); });
    let unavailable = true;
    const providerMessages = new Map<string, string>();
    const accepted = async (value: any) => {
      if (unavailable && !value.fileKey) throw new Error('provider temporarily unavailable');
      if (!providerMessages.has(value.idempotencyKey)) providerMessages.set(value.idempotencyKey, `om_${providerMessages.size}`);
      return { messageId: providerMessages.get(value.idempotencyKey)! };
    };
    const service = { uploadFile: vi.fn(async (_value: any) => 'file_key'), replyFile: vi.fn(accepted), sendFile: vi.fn(accepted), reply: vi.fn(accepted), send: vi.fn(accepted) };
    const original = input('完整结果🙂'.repeat(5000));
    const target = { chatId: 'oc_group', replyMessageId: 'om_question', replyInThread: true };
    await expect(sendLarkResult(service as any, target, original, log, repos.config)).rejects.toThrow('temporarily unavailable');
    expect(providerMessages.size).toBe(1);
    expect(service.replyFile).toHaveBeenCalledOnce();
    repos.close();
    repos = createRepositories(join(dir, 'state.db'));
    unavailable = false;
    const result = await sendLarkResult(service as any, target, original, log, repos.config);
    expect(result).toMatchObject({ messageId: 'om_1', attachmentMessageId: 'om_0' });
    expect(service.uploadFile).toHaveBeenCalledOnce();
    expect(service.replyFile).toHaveBeenCalledOnce();
    expect(providerMessages.size).toBe(2);
    const calls = service.reply.mock.calls.length;
    expect(await sendLarkResult(service as any, target, original, log, repos.config)).toEqual(result);
    expect(service.reply).toHaveBeenCalledTimes(calls);
    expect(providerMessages.size).toBe(2);
  });
});

describe('原消息上的状态表情', () => {
  const setup = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-status-reaction-'));
    const repos = createRepositories(join(dir, 'state.db'));
    cleanups.push(async () => { repos.close(); await rm(dir, { recursive: true, force: true }); });
    let next = 0;
    const service = {
      addReaction: vi.fn(async (messageId: string, emojiType: string) => ({ messageId, emojiType, reactionId: `r_${++next}_${emojiType}` })),
      deleteReaction: vi.fn(async (_messageId: string, _reactionId: string) => {})
    };
    const react = (completed: boolean) => deliverLarkStatusReaction(service, { appId: 'cli_app', messageId: 'om_req', completed }, log, repos.config);
    return { repos, service, react };
  };

  it('完成贴对勾、失败贴叉号，对账重入不重复贴', async () => {
    const h = await setup();
    expect(await h.react(false)).toBe(true);
    expect(await h.react(false)).toBe(true);
    expect(h.service.addReaction.mock.calls).toEqual([['om_req', FAILURE_REACTION_EMOJI]]);
    expect(h.service.deleteReaction).not.toHaveBeenCalled();
  });

  it('同一条消息之后又有新终态：先撤旧的再贴新的，来回切换始终只留一枚', async () => {
    const h = await setup();
    await h.react(false);
    await h.react(true);
    expect(h.service.deleteReaction.mock.calls).toEqual([['om_req', `r_1_${FAILURE_REACTION_EMOJI}`]]);
    expect(h.service.addReaction.mock.calls.map(([, emoji]) => emoji)).toEqual([FAILURE_REACTION_EMOJI, COMPLETION_REACTION_EMOJI]);
    // 撤掉的那一枚记作已撤销，再失败一次可以重新贴上，不会被幂等键挡住。
    await h.react(false);
    expect(h.service.deleteReaction.mock.calls.at(-1)).toEqual(['om_req', `r_2_${COMPLETION_REACTION_EMOJI}`]);
    expect(h.service.addReaction.mock.calls.map(([, emoji]) => emoji)).toEqual([FAILURE_REACTION_EMOJI, COMPLETION_REACTION_EMOJI, FAILURE_REACTION_EMOJI]);
    expect(JSON.parse((await h.repos.config.get(reactionDedupeKey('cli_app', 'om_req', COMPLETION_REACTION_EMOJI)))!).removedAt).toBeTruthy();
    expect(JSON.parse((await h.repos.config.get(reactionDedupeKey('cli_app', 'om_req', FAILURE_REACTION_EMOJI)))!)).toMatchObject({ reactionId: `r_3_${FAILURE_REACTION_EMOJI}` });
  });

  it('贴表情失败只告警、返回 false，不抛给调用方；撤旧失败时照贴新的', async () => {
    const h = await setup();
    h.service.addReaction.mockRejectedValueOnce(new Error('rate limited'));
    expect(await h.react(true)).toBe(false);
    expect(await h.repos.config.get(reactionDedupeKey('cli_app', 'om_req', COMPLETION_REACTION_EMOJI))).toBeUndefined();
    expect(await h.react(true)).toBe(true);
    h.service.deleteReaction.mockRejectedValueOnce(new Error('network'));
    expect(await h.react(false)).toBe(true);
    expect(h.service.addReaction.mock.calls.at(-1)).toEqual(['om_req', FAILURE_REACTION_EMOJI]);
  });
});
