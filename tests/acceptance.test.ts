import { describe, expect, it } from 'vitest';
import { builtinAgents } from '@dockmux/config';
import { createRepositories } from '@dockmux/storage';
import { agentConfigSchema } from '@dockmux/shared';
import { normalizeAcpxEvent } from '@dockmux/acp-client';
import { correlateToolCalls, selectProtocol } from '@dockmux/runtime';

describe('acceptance foundations (specified before implementation)', () => {
  it('requires approval by default', () => {
    expect(agentConfigSchema.parse({ id: 'x', name: 'x', command: 'x' }).permissionMode).toBe('ask');
    expect(builtinAgents().every(a => a.permissionMode === 'ask')).toBe(true);
  });

  it.each(builtinAgents().map(agent => [agent.id, agent] as const))('%s is a scanned ACPX agent', (_id, agent) => {
    expect(agent.protocol).toBe('acp');
    expect(agent.command).toBeTruthy();
  });

  it('uses ACPX registry commands for discovered agents', () => {
    for (const agent of builtinAgents('/work')) expect(agent).toMatchObject({ protocol: 'acp', cwd: '/work', permissionMode: 'ask' });
  });

  it('falls back ACP -> JSONL -> PTY based on probes', () => {
    expect(selectProtocol({ acp: false, jsonl: true, pipe: true, pty: true })).toBe('jsonl');
    expect(selectProtocol({ acp: false, jsonl: false, pipe: false, pty: true })).toBe('pty');
  });

  it('correlates tool calls and results', () => {
    const call = normalizeAcpxEvent({ type: 'tool_call', toolCallId: 't1', title: 'Read', status: 'in_progress', rawInput: { path: 'x' } });
    const result = normalizeAcpxEvent({ type: 'tool_call', toolCallId: 't1', title: 'Read', status: 'completed', rawOutput: 'ok' });
    const correlated = correlateToolCalls([call!, result!]);
    expect(correlated.get('t1')).toMatchObject({ id: 't1', output: 'ok', status: 'completed' });
  });

  it('preserves unparseable output as raw terminal', () => {
    expect(normalizeAcpxEvent('not-json')).toMatchObject({ type: 'raw_terminal', raw: 'not-json' });
  });

  it('SQLite repositories save and restore sessions and events', async () => {
    const repos = createRepositories(':memory:');
    const session = { id: 's1', agentId: 'mock', state: 'idle' as const, cwd: '/tmp', runId: 'r1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await repos.sessions.save(session);
    await repos.events.append({ id: 'e1', sessionId: 's1', sequence: 1, type: 'text', timestamp: new Date().toISOString(), data: { text: 'hello' } });
    expect(await repos.sessions.get('s1')).toMatchObject(session);
    expect(await repos.events.list('s1')).toHaveLength(1);
    repos.close();
  });
});
