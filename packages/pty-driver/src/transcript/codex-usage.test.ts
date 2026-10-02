import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, appendFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:fs', async importOriginal => { const original = await importOriginal<typeof import('node:fs')>(); return { ...original, createReadStream: vi.fn(original.createReadStream) }; });
import { walkFiles, readHead } from '../session-id/fs-scan.js';
vi.mock('../session-id/fs-scan.js', async importOriginal => { const original = await importOriginal<typeof import('../session-id/fs-scan.js')>(); return { ...original, walkFiles: vi.fn(original.walkFiles), readHead: vi.fn(original.readHead) }; });
import { mapCodexEntry, readCodexSessionUsage } from './codex.js';
it('maps Codex token_count current context separately from cumulative tokens and duration-based quotas', () => {
  const events = mapCodexEntry({ type: 'event_msg', timestamp: '2026-10-02T00:00:00Z', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 150 }, total_token_usage: { total_tokens: 99999 }, model_context_window: 10000 }, rate_limits: { primary: { used_percent: 0, window_minutes: 10080, resets_at: 1791000000 }, secondary: null } } });
  expect(events).toMatchObject([{ type: 'status', data: { state: 'usage', used: 150, size: 10000, rateLimits: { sevenDay: { usedPercent: 0 } } } }]);
  expect(events?.[0]?.data).not.toHaveProperty('rateLimits.fiveHour');
  expect(mapCodexEntry({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } })).toBeUndefined();
});

it('reads only appended bytes after the first poll and retains a partial JSONL line', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-rollout-usage-'));
  const dir = join(cwd, 'sessions', '2026', '10', '02'); await mkdir(dir, { recursive: true });
  const path = join(dir, 'rollout-old-native-id.jsonl');
  const usage = (used: number) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-02T00:00:00Z', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: used }, model_context_window: 1000 } } });
  const head = JSON.stringify({ type: 'session_meta', payload: { id: 'native-id', cwd } }) + '\n' + usage(10) + '\n';
  const env = { CODEX_HOME: cwd };
  try {
    await writeFile(path, head);
    for (let i = 0; i < 65; i++) await writeFile(join(dir, `rollout-new-other-${i}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: `other-${i}`, cwd } }) + '\n');
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(10);
    const calls = vi.mocked(fs.createReadStream).mock.calls.length;
    const walks = vi.mocked(walkFiles).mock.calls.length;
    const heads = vi.mocked(readHead).mock.calls.length;
    expect(heads).toBe(0); // Exact filename match avoids scanning unrelated rollout heads.
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(10);
    expect(vi.mocked(fs.createReadStream).mock.calls.length).toBe(calls);
    expect(vi.mocked(walkFiles).mock.calls.length).toBe(walks);
    expect(vi.mocked(readHead).mock.calls.length).toBe(heads);
    const next = usage(20);
    await appendFile(path, next.slice(0, 30));
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(10);
    expect(vi.mocked(fs.createReadStream).mock.calls.at(-1)?.[1]).toMatchObject({ start: Buffer.byteLength(head) });
    await appendFile(path, next.slice(30) + '\n');
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(20);
    expect(vi.mocked(walkFiles).mock.calls.length).toBe(walks);
    expect(vi.mocked(readHead).mock.calls.length).toBe(heads);
    await rm(path);
    await writeFile(join(dir, 'rollout-renamed-native-id.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'native-id', cwd } }) + '\n' + usage(30) + '\n');
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(30);
    expect(vi.mocked(walkFiles).mock.calls.length).toBeGreaterThan(walks);
    expect(await readCodexSessionUsage('native-id', env, 'other-cwd')).toBeUndefined();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
