import { afterEach, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), createReadStream: vi.fn((await original<typeof import('node:fs')>()).createReadStream) }));
import { verifyTranscriptCheckpoint } from '../transcript-source.js';
import { buildSessionMarker } from '../session-id/marker.js';
import { readNativeTranscriptUsage, type NativeUsageSource } from './session-usage.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function sample(client: 'claude' | 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'native-usage-')); dirs.push(root);
  const path = join(root, 'transcript.jsonl');
  const fixture = new URL(`./fixtures/usage-${client}-${client === 'claude' ? '2.1.295' : '0.162.1'}.jsonl`, import.meta.url);
  await writeFile(path, await readFile(fixture));
  return { client, path, dataRoot: root, cwd: '/workspace/usage', nativeSessionId: `native-${client}` } satisfies NativeUsageSource;
}
const next = (id: string, output = 10) => JSON.stringify({ type: 'assistant', sessionId: 'native-claude', timestamp: '2026-10-13T09:00:00Z', message: { id, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } });
it('reads real CLI schema: Codex cumulative differs from current context, cached input is a subset, quota windows independent', async () => {
  const source = await sample('codex');
  expect(await readNativeTranscriptUsage(source)).toMatchObject({ context: { used: 40596, size: 475000 }, nativeTokens: { inputTokens: 41029, cacheReadTokens: 107392, outputTokens: 864, totalTokens: 149285, scope: 'current_native_session', source: 'codex_transcript' }, rateLimits: { sevenDay: { usedPercent: 3 } } });
  expect((await readNativeTranscriptUsage(source))?.rateLimits?.fiveHour).toBeUndefined();
});
it('deduplicates Claude message snapshots, excludes errors/sidechains/synthetic/cost-state, reads appended bytes and retains partial UTF-8 lines', async () => {
  const source = await sample('claude');
  const first = await readNativeTranscriptUsage(source);
  expect(first).toMatchObject({ context: { used: 116348 }, nativeTokens: { inputTokens: 2, outputTokens: 812, cacheReadTokens: 115780, cacheWriteTokens: 566, totalTokens: 117160 } });
  expect(first?.context?.size).toBeUndefined(); expect(first?.rateLimits).toBeUndefined();
  const before = vi.mocked(fs.createReadStream).mock.calls.length;
  await readNativeTranscriptUsage(source); expect(vi.mocked(fs.createReadStream).mock.calls.length).toBe(before);
  const bytes = Buffer.from(next('msg-中文'));
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  const start = (await fs.promises.stat(source.path)).size;
  await appendFile(source.path, bytes.subarray(0, split));
  expect((await readNativeTranscriptUsage(source))?.nativeTokens?.totalTokens).toBe(117160);
  await appendFile(source.path, Buffer.concat([bytes.subarray(split), Buffer.from('\n')]));
  expect((await readNativeTranscriptUsage(source))?.nativeTokens?.totalTokens).toBe(117230);
  expect(vi.mocked(fs.createReadStream).mock.calls.at(-1)?.[1]).toMatchObject({ start: start + split });
  await appendFile(source.path, next('msg-中文', 20).replace('\"message\":', '\"cwd\":\"/workspace/changed-by-agent\",\"message\":') + '\n');
  expect((await readNativeTranscriptUsage(source))?.nativeTokens?.totalTokens).toBe(117240);
  const shared = await Promise.all([readNativeTranscriptUsage(source), readNativeTranscriptUsage(source)]);
  shared[0]!.context!.used = 1; expect(shared[1]!.context!.used).toBe(60);
});
it('rejects unrelated identities, wrong roots, symlinks and resets old readings after replacement or truncation', async () => {
  const source = await sample('claude'); await readNativeTranscriptUsage(source);
  expect(await readNativeTranscriptUsage({ ...source, nativeSessionId: 'other' })).toBeUndefined();
  await expect(readNativeTranscriptUsage({ ...source, dataRoot: join(source.dataRoot, 'missing') })).rejects.toThrow();
  const outside = await sample('claude');
  expect(await readNativeTranscriptUsage({ ...source, path: outside.path })).toBeUndefined();
  const link = join(source.dataRoot, 'symlink.jsonl'); await symlink(source.path, link);
  await expect(readNativeTranscriptUsage({ ...source, path: link })).rejects.toThrow();
  await rm(source.path); await writeFile(source.path, JSON.stringify({ type: 'user', sessionId: 'other', cwd: source.cwd }) + '\n' + next('msg-new') + '\n');
  expect(await readNativeTranscriptUsage(source)).toBeUndefined();
  await writeFile(source.path, JSON.stringify({ type: 'user', sessionId: source.nativeSessionId, cwd: source.cwd }) + '\n');
  expect(await readNativeTranscriptUsage(source)).toEqual({});
});
it('accepts realpath-equivalent working directories and labels skipped oversized Claude records partial', async () => {
  const source = await sample('claude');
  const cwd = join(source.dataRoot, 'cwd'); const alias = join(source.dataRoot, 'alias'); await mkdir(cwd); await symlink(cwd, alias);
  const original = await readFile(source.path, 'utf8'); await writeFile(source.path, original.replaceAll('/workspace/usage', cwd));
  const bound = { ...source, cwd: alias };
  expect((await readNativeTranscriptUsage(bound))?.nativeTokens?.totalTokens).toBe(117160);
  await appendFile(source.path, JSON.stringify({ type: 'assistant', padding: 'x'.repeat(1100000), message: { id: 'huge', usage: { input_tokens: 1 } } }) + '\n');
  expect((await readNativeTranscriptUsage(bound))?.nativeTokens).toMatchObject({ totalTokens: 117160, partial: true });
});

it('verifies a checkpoint marker and initial cwd while allowing later cwd changes in that same native session', async () => {
  const source = await sample('claude');
  const id = 'ses_checkpoint_usage';
  const user = { type: 'user', sessionId: source.nativeSessionId, cwd: source.cwd, message: { role: 'user', content: buildSessionMarker(id) } };
  await writeFile(source.path, JSON.stringify(user) + '\n' + next('msg-checkpoint').replace('"message":', '"cwd":"/workspace/changed","message":') + '\n');
  expect(verifyTranscriptCheckpoint('claude', source.path, source.dataRoot, { sessionId: id, cwd: source.cwd })?.nativeSessionId).toBe(source.nativeSessionId);
  expect(verifyTranscriptCheckpoint('claude', source.path, source.dataRoot, { sessionId: 'ses_other', cwd: source.cwd })).toBeUndefined();
  expect(verifyTranscriptCheckpoint('claude', source.path, source.dataRoot, { sessionId: id, cwd: '/other' })).toBeUndefined();
});
