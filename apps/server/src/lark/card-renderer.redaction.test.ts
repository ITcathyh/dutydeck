import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { renderLarkProcessElements, renderLarkRecordExport, renderLarkResultElements, renderLarkResultTextElements } from './card-renderer.js';
import { sendLarkFile, sendLarkResult } from './result-delivery.js';
import { buildLarkCard } from './service.js';

const event = (type: AgentEvent['type'], data: Record<string, unknown>): AgentEvent => ({
  id: type, sessionId: 'session', sequence: type === 'text' ? 1 : 2, timestamp: '2026-10-22T00:00:00Z', type, data
});

describe('credential redaction in Lark results', () => {
  it('redacts JSON passwords with escaped quotes before card and record delivery', async () => {
    const password = 'alpha" tail_secret_value';
    const payload = JSON.stringify({ password, status: 'kept' });
    const events = [event('text', { role: 'assistant', text: payload })];
    let card = '';
    let uploaded = '';
    const service = {
      send: vi.fn(async input => { card = JSON.stringify(buildLarkCard(input)); return { messageId: 'card' }; }),
      uploadFile: vi.fn(async input => { uploaded = Buffer.from(input.data).toString('utf8'); return 'file-key'; }),
      sendFile: vi.fn(async () => ({ messageId: 'file' }))
    };
    const log = { warn: vi.fn() };
    await sendLarkResult(service as any, { chatId: 'chat' }, {
      cardKind: 'result', state: 'completed', elements: renderLarkResultElements(events, { state: 'completed' }), idempotencyKey: 'result'
    }, log);
    expect(service.send).toHaveBeenCalledOnce();
    expect(card).not.toContain('tail_secret_value');
    expect(card).toContain('kept');
    expect(card).toContain('[REDACTED]');
    for (const output of [payload, { stdout: payload }, { password, status: 'kept' }]) {
      const record = renderLarkRecordExport([...events, event('tool_result', { id: 'tool', name: 'ReadConfig', status: 'completed', output })]);
      await sendLarkFile(service as any, { chatId: 'chat' }, { data: Buffer.from(record), filename: 'record.md', idempotencyKey: 'record' }, log);
      expect(uploaded).not.toContain('tail_secret_value');
      expect(uploaded).toContain('kept');
      expect(uploaded).toContain('[REDACTED]');
    }
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('Agent text cannot forge Lark card tags', () => {
  const forged = '**完成** <at id=all></at> <AT id=ou_victim></at> <text_tag color=\'green\'>已授权</text_tag> </font><font color=\'red\'>x</font>';
  const assertNeutral = (content: string) => {
    expect(content).not.toMatch(/<\/?\s*(?:at|text_tag|font)\b/i);
    expect(content).toContain('＜at id=all>');
    expect(content).toContain('**完成**');
  };

  it('neutralizes mentions and tags in result text while keeping ordinary markdown and code', () => {
    const [element] = renderLarkResultTextElements(`${forged}\n\n\`List<String>\` 且 a < b`);
    assertNeutral(element!.content as string);
    expect(element!.content).toContain('`List<String>` 且 a < b');
  });

  it('neutralizes the final output of result and progress cards', () => {
    const events = [event('text', { role: 'assistant', text: forged })];
    assertNeutral(renderLarkResultElements(events).find(element => element.element_id === 'final_output')!.content as string);
    const progress = renderLarkProcessElements(events, {}, false);
    for (const element of progress) if (typeof element.content === 'string') expect(element.content).not.toMatch(/<\/?\s*at\b/i);
  });

  it('escapes the Agent-supplied permission title so it cannot show a fake approval tag', () => {
    const elements = renderLarkProcessElements([event('permission_request', { title: "<text_tag color='green'>已授权</text_tag> rm -rf /", status: 'pending' })], {}, false);
    const alert = elements.find(element => String(element.element_id).startsWith('risk_alert_pending'));
    expect(alert!.content).not.toContain('<text_tag');
    expect(alert!.content).toContain('rm -rf /');
  });
});
