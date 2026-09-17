import { describe, expect, it, vi } from 'vitest';
import { AgentGroupToolCliError } from './agent-tools-cli.js';
import { runMemoryAdd, runMemoryList, runMemoryRemove } from './memory-cli.js';

const env = { dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dutydeck_group_tools_token: 'capability-token' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('memory CLI client', () => {
  it('requires the session capability from the environment', () => {
    let caught: unknown;
    try { void runMemoryList({ env: {} }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AgentGroupToolCliError);
    expect((caught as AgentGroupToolCliError).error.code).toBe('GROUP_TOOL_CONTEXT_REQUIRED');
  });

  it('maps list, add and remove onto the scoped memory endpoint', async () => {
    const fetcher = vi.fn(async () => response({ chatId: 'oc_group', entries: [] }));
    await runMemoryList({ env, fetcher: fetcher as typeof fetch });
    await runMemoryAdd('项目用 pnpm', { env, fetcher: fetcher as typeof fetch });
    await runMemoryRemove('mem_1a2b3c4d', { env, fetcher: fetcher as typeof fetch });
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => [url, init.method ?? 'GET'])).toEqual([
      ['http://127.0.0.1:4310/api/lark/agent-tools/memory', 'GET'],
      ['http://127.0.0.1:4310/api/lark/agent-tools/memory', 'POST'],
      ['http://127.0.0.1:4310/api/lark/agent-tools/memory/mem_1a2b3c4d', 'DELETE']
    ]);
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ content: '项目用 pnpm' });
    for (const [, init] of calls) expect(new Headers(init.headers).get('authorization')).toBe('Bearer capability-token');
  });

  it('surfaces server error bodies as CLI errors', async () => {
    const fetcher = vi.fn(async () => response({ error: { code: 'MEMORY_NOT_FOUND', message: '没有这条记忆' } }, 404));
    await expect(runMemoryRemove('mem_deadbeef', { env, fetcher: fetcher as typeof fetch })).rejects.toMatchObject({ error: { code: 'MEMORY_NOT_FOUND' }, statusCode: 404 });
  });
});
