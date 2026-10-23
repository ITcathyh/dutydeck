import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, appendFile, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
vi.mock('node:fs', async importOriginal => { const original = await importOriginal<typeof import('node:fs')>(); return { ...original, createReadStream: vi.fn(original.createReadStream) }; });
import { walkFiles, readFirstLine } from '../session-id/fs-scan.js';
vi.mock('../session-id/fs-scan.js', async importOriginal => { const original = await importOriginal<typeof import('../session-id/fs-scan.js')>(); return { ...original, walkFiles: vi.fn(original.walkFiles), readFirstLine: vi.fn(original.readFirstLine) }; });
import { mapCodexEntry, readCodexSessionUsage } from './codex.js';
const sid = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const usageRecord = (used: number) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-22T00:00:00Z', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: used }, model_context_window: 1000 } } }) + '\n';
beforeEach(() => vi.clearAllMocks());

it.each(['generation', 'native index'] as const)('refreshes usage after a %s switch while the old rollout remains', async kind => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-switch-'));
  const root = join(cwd, 'sessions'); await mkdir(root);
  const originalNow = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow);
  const old = join(root, `rollout-2026-10-20T00-00-00-${sid}.jsonl`);
  // The index may intentionally select an older filename than the active one.
  const next = join(root, `rollout-2026-10-${kind === 'native index' ? '19' : '21'}T00-00-00-${sid}_${generation}.jsonl`);
  const record = (id: string, used: number) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n' + usageRecord(used);
  const index = (path: string) => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(join(cwd, 'state_5.sqlite'));
    try {
      db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
      db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?)').run(sid, path);
    } finally { db.close(); }
  };
  try {
    await writeFile(old, record(sid, 10));
    if (kind === 'native index') index(old);
    expect((await readCodexSessionUsage(sid, { CODEX_HOME: cwd }, cwd))?.context?.used).toBe(10);
    const walks = vi.mocked(walkFiles).mock.calls.length;
    await writeFile(next, record(sid, 30));
    if (kind === 'native index') index(next);
    expect((await readCodexSessionUsage(sid, { CODEX_HOME: cwd }, cwd))?.context?.used).toBe(10);
    expect(vi.mocked(walkFiles).mock.calls.length).toBe(walks);
    clock.mockReturnValue(originalNow + 1_001);
    expect((await readCodexSessionUsage(sid, { CODEX_HOME: cwd }, cwd))?.context?.used).toBe(30);
    expect(fs.existsSync(old)).toBe(true);
    const reads = vi.mocked(fs.createReadStream).mock.calls.length;
    expect((await readCodexSessionUsage(sid, { CODEX_HOME: cwd }, cwd))?.context?.used).toBe(30);
    expect(vi.mocked(fs.createReadStream).mock.calls.length).toBe(reads);
    await appendFile(next, usageRecord(40));
    expect((await readCodexSessionUsage(sid, { CODEX_HOME: cwd }, cwd))?.context?.used).toBe(40);
  } finally { clock.mockRestore(); await rm(cwd, { recursive: true, force: true }); }
});

it('refuses a foreign generation when refreshing usage', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-usage-foreign-'));
  const root = join(cwd, 'sessions'); await mkdir(root);
  const originalNow = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow);
  const record = (id: string, used: number) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n' + usageRecord(used);
  try {
    await writeFile(join(root, `rollout-2026-10-20T00-00-00-${sid}.jsonl`), record(sid, 10));
    expect((await readCodexSessionUsage(sid, { CODEX_HOME: cwd }, cwd))?.context?.used).toBe(10);
    await writeFile(join(root, `rollout-2026-10-21T00-00-00-${sid}_${generation}.jsonl`), record('foreign-session', 99));
    clock.mockReturnValue(originalNow + 1_001);
    expect((await readCodexSessionUsage(sid, { CODEX_HOME: cwd }, cwd))?.context?.used).toBe(10);
  } finally { clock.mockRestore(); await rm(cwd, { recursive: true, force: true }); }
});
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
    const heads = vi.mocked(readFirstLine).mock.calls.length;
    expect(heads).toBe(1); // Verify only the named file, without reading unrelated rollout heads.
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(10);
    expect(vi.mocked(fs.createReadStream).mock.calls.length).toBe(calls);
    expect(vi.mocked(walkFiles).mock.calls.length).toBe(walks);
    expect(vi.mocked(readFirstLine).mock.calls.length).toBe(heads);
    const next = usage(20);
    await appendFile(path, next.slice(0, 30));
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(10);
    expect(vi.mocked(fs.createReadStream).mock.calls.at(-1)?.[1]).toMatchObject({ start: Buffer.byteLength(head) });
    await appendFile(path, next.slice(30) + '\n');
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(20);
    expect(vi.mocked(walkFiles).mock.calls.length).toBe(walks);
    expect(vi.mocked(readFirstLine).mock.calls.length).toBe(heads);
    await rm(path);
    await writeFile(join(dir, 'rollout-renamed-native-id.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'native-id', cwd } }) + '\n' + usage(30) + '\n');
    expect((await readCodexSessionUsage('native-id', env, cwd))?.context?.used).toBe(30);
    expect(vi.mocked(walkFiles).mock.calls.length).toBeGreaterThan(walks);
    expect(await readCodexSessionUsage('native-id', env, 'other-cwd')).toBeUndefined();
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
