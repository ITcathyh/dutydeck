import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runWorkCommand } from './work-item-cli.js';

it('sends dutydeck work revise to the bound tool with the file body and optional dry run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-work-cli-'));
  try {
    const file = join(root, 'revision.json');
    await writeFile(file, '{"expectedRevision":2,"plan":{"title":"P"}}');
    const fetcher = vi.fn(async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
    const env = { dutydeck_group_tools_url: 'http://127.0.0.1:4310/api/lark/agent-tools', dutydeck_group_tools_token: 'capability-token' };
    await runWorkCommand('revise', ['goal 1'], { file, turn: 'turn', dryRun: true }, { env, fetcher: fetcher as typeof fetch });
    await runWorkCommand('revise', ['goal 1'], { file, turn: 'turn' }, { env, fetcher: fetcher as typeof fetch });
    const calls = fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual(Array(2).fill(`${env.dutydeck_group_tools_url}/work-items/goal%201/revise`));
    expect(calls.map(([, init]) => JSON.parse(String(init.body)))).toEqual([{ expectedRevision: 2, plan: { title: 'P' }, dryRun: true }, { expectedRevision: 2, plan: { title: 'P' } }]);
    expect(new Headers(calls[0]![1].headers).get('x-dutydeck-work-turn')).toBe('turn');
    await expect(runWorkCommand('revise', ['goal'], { turn: 'turn' }, { env, fetcher: fetcher as typeof fetch })).rejects.toThrow('--file');
  } finally { await rm(root, { recursive: true, force: true }); }
});
