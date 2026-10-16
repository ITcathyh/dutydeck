import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { renderLarkCardElements, renderLarkRecordExport, renderLarkResultElements } from './card-renderer.js';
import { larkMemoryScope, LarkMemoryStore, looksLikeLarkMemoryCredential } from './memory.js';
import { redactTraceText } from './secret-redaction.js';

const event = (sequence: number, type: AgentEvent['type'], data: AgentEvent['data']): AgentEvent => ({
  id: `evt_${sequence}`, sessionId: 'ses_redaction', sequence, type, data, timestamp: '2026-01-01T00:00:00.000Z'
});

const escapedQuoteCommand = String.raw`export SECRET_KEY="first \"middle\" LAST_CANARY"; echo done`;

const credentials = [
  { text: 'SECRET_KEY=synthetic-secret-canary', secret: 'synthetic-secret-canary' },
  { text: 'BYTEDCLI_USER_CLOUD_JWT=synthetic-jwt-canary', secret: 'synthetic-jwt-canary' },
  { text: 'jwt: synthetic-jwt-canary', secret: 'synthetic-jwt-canary' },
  { text: 'login --secret-key synthetic-flag-canary', secret: 'synthetic-flag-canary' },
  { text: 'login --jwt synthetic-flag-canary', secret: 'synthetic-flag-canary' },
  { text: JSON.stringify({ command: 'export SECRET_KEY="synthetic escaped secret phrase"; echo done' }), secret: 'secret phrase' },
  { text: escapedQuoteCommand, secret: 'LAST_CANARY' },
  { text: JSON.stringify({ command: escapedQuoteCommand }), secret: 'LAST_CANARY' },
  ...['sk-', 'sk-proj-', 'sk-svcacct-', 'sk-ant-api03-'].map(prefix => ({ text: `${prefix}SYNTHETIC_CANARY_1234567890`, secret: `${prefix}SYNTHETIC_CANARY_1234567890` })),
  { text: 'https://user:p@ss@host.example/path', secret: 'ss@host.example' }
];

describe('credential redaction at delivery and memory boundaries', () => {
  it.each([escapedQuoteCommand, JSON.stringify({ command: escapedQuoteCommand })])('consumes escaped quotes inside the entire credential while preserving subsequent commands: %s', text => {
    const events = [
      event(1, 'tool_call', { id: 'tool', name: 'Bash', input: { command: text }, status: 'running' }),
      event(2, 'tool_result', { id: 'tool', name: 'Bash', output: text, status: 'completed' }),
      event(3, 'text', { text })
    ];
    for (const rendered of [
      redactTraceText(text),
      JSON.stringify(renderLarkResultElements(events)),
      JSON.stringify(renderLarkCardElements(events, { hideTraceOnComplete: false }, true)),
      renderLarkRecordExport(events)
    ]) {
      for (const fragment of ['first', 'middle', 'LAST_CANARY']) expect(rendered).not.toContain(fragment);
      expect(rendered).toContain('echo done');
    }
  });

  it.each(credentials)('redacts $text from result cards, tool cards and public exports', ({ text, secret }) => {
    const events = [
      event(1, 'tool_call', { id: 'tool', name: 'Bash', input: { command: text }, status: 'running' }),
      event(2, 'tool_result', { id: 'tool', name: 'Bash', output: text, status: 'completed' }),
      event(3, 'text', { text })
    ];
    for (const rendered of [
      JSON.stringify(renderLarkResultElements(events)),
      JSON.stringify(renderLarkCardElements(events, { hideTraceOnComplete: false }, true)),
      renderLarkRecordExport(events)
    ]) {
      expect(rendered).not.toContain(secret);
      expect(rendered).toContain('[REDACTED]');
    }
  });

  it('redacts structured secret-key and JWT fields before formatting tool output', () => {
    const events = [event(1, 'tool_result', { id: 'tool', name: 'read', status: 'completed', output: {
      SECRET_KEY: ['synthetic-structured-secret'], account: { session_jwt: 'synthetic-structured-jwt' }, summary: '正常业务结论'
    } })];
    for (const rendered of [JSON.stringify(renderLarkCardElements(events, { hideTraceOnComplete: false }, true)), renderLarkRecordExport(events)]) {
      expect(rendered).not.toContain('synthetic-structured-secret');
      expect(rendered).not.toContain('synthetic-structured-jwt');
      expect(rendered).toContain('正常业务结论');
    }
  });

  it('rejects recognized credentials before saving memory through direct and batch writes', async () => {
    const repositories = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const memory = new LarkMemoryStore(repositories.config);
    const scope = larkMemoryScope('cli_redaction', 'oc_source', 'group');
    try {
      for (const { text } of credentials) {
        expect(looksLikeLarkMemoryCredential(text), text).toBe(true);
        await expect(memory.add(scope, { content: text, source: 'agent' })).rejects.toMatchObject({ code: 'MEMORY_CREDENTIAL_REJECTED' });
        await expect(memory.applyBatch(scope, [{ op: 'add', input: { content: text, source: 'extraction' } }])).rejects.toMatchObject({ code: 'MEMORY_CREDENTIAL_REJECTED' });
      }
      expect(await memory.list(larkMemoryScope('cli_redaction', 'oc_other', 'group'))).toEqual([]);
      const ordinary = '项目用 pnpm；SECRET_KEY 和 JWT 是配置项名称，sk-short 是示例标签，文档在 https://docs.example.com/guide。';
      expect(redactTraceText(ordinary)).toBe(ordinary);
      expect(looksLikeLarkMemoryCredential(ordinary)).toBe(false);
      await expect(memory.add(scope, { content: ordinary, source: 'user' })).resolves.toMatchObject({ content: ordinary });
      expect(renderLarkResultElements([event(1, 'text', { text: ordinary })])).toEqual([expect.objectContaining({ content: ordinary })]);
    } finally {
      repositories.close();
    }
  });
});
