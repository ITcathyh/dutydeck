import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { AgentEvent } from '@dutydeck/shared';
import { loadLarkTaskEvents, renderLarkProcessElements, renderLarkResultElements } from './card-renderer.js';
import { larkResultKey, patchLarkCard, sendLarkResult } from './result-delivery.js';
import { buildLarkCard, LarkCardService, LarkServiceError } from './service.js';

const event = (sequence: number, type: AgentEvent['type'], data: any): AgentEvent => ({
  id: `e${sequence}`, sessionId: 'ses_1', sequence, type, data, timestamp: '2026-09-08T00:00:00Z'
});
const log = { warn: vi.fn() };
const input = (text: string) => ({ state: 'completed' as const, taskId: 'task1', readOnly: true,
  elements: renderLarkResultElements([event(1, 'text', { text })]), idempotencyKey: larkResultKey('om_process') });

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
    original.elements.push({ tag: 'markdown', element_id: 'group_mention', content: '<at user_id="ou_owner">成员</at>' },
      { tag: 'button', element_id: 'workflow_accept', text: { tag: 'plain_text', content: '验收通过' } });
    const result = await sendLarkResult(service as any, { chatId: 'oc_group', replyMessageId: 'om_question', replyInThread: true },
      { ...original, taskName: '创建机器人', turn: 1, recordExport: true }, log);
    const uploaded = Buffer.from(service.uploadFile.mock.calls[0]![0].data).toString('utf8');
    expect(uploaded).toBe(`${text}\n\n---\n\n结果验收：回复本文件消息「验收通过」即可确认；需要修改时，回复本文件消息并说明修改要求。`);
    expect(service.uploadFile.mock.calls[0]![0].filename).toBe('创建机器人.md');
    expect(service.replyFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: 'om_question', replyInThread: true, fileKey: 'file_full' }));
    expect(service.reply).toHaveBeenCalledOnce();
    const summary = service.reply.mock.calls[0]![0];
    expect(summary.idempotencyKey).not.toBe(service.replyFile.mock.calls[0]![0].idempotencyKey);
    const card = buildLarkCard(summary);
    expect(card.header.title.content).toBe('执行结果 · 创建机器人');
    expect(card.config.summary.content).toContain('本轮结束');
    expect(JSON.stringify(card)).toContain('尚待用户扫码，创建尚未完成。');
    expect(JSON.stringify(card)).toContain('正文开头节选（非完整结论）');
    expect(JSON.stringify(card)).toContain('workflow_accept');
    expect(JSON.stringify(card)).toContain('<at user_id=');
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(24 * 1024);
    expect(result).toMatchObject({ messageId: 'om_summary', attachmentMessageId: 'om_file', elements: summary.elements });
    expect(service.send).not.toHaveBeenCalled();
    expect(service.sendFile).not.toHaveBeenCalled();
  });

  it('uses the same result UUID for reply fallback and propagates a failed delivery', async () => {
    const service = { reply: vi.fn(async () => { throw new Error('missing question'); }), send: vi.fn(async () => { throw new Error('unavailable'); }) };
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
