import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { renderLarkRecordExport, renderLarkResultElements } from './card-renderer.js';
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
