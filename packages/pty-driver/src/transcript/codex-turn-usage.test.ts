import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodexTranscriptTailer } from './codex.js';

// Hand-written minimal records in the shape of codex-cli 0.166 rollouts (token_usage_record per response,
// token_count with cumulative total_token_usage written once or more after it).
const sid = '11111111-1111-4111-8111-111111111111', gen = '22222222-2222-4222-8222-222222222222';
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const meta = (id = sid) => line({ type: 'session_meta', payload: { id, cwd: '/tmp' } });
const context = (model: string) => line({ type: 'turn_context', payload: { turn_id: 't', model, effort: 'xhigh' } });
const response = (id: string, own: [number, number, number], thread: [number, number, number], ordinal = 0, threadId = sid) =>
  line({ type: 'token_usage_record', ordinal, payload: { thread_id: threadId, turn_id: 't', response_id: id, usage: usage(...own), thread_token_usage: usage(...thread) } });
const tokenCount = (total: [number, number, number], last: [number, number, number], timestamp?: string) =>
  line({ type: 'event_msg', ...(timestamp ? { timestamp } : {}), payload: { type: 'token_count', info: { total_token_usage: usage(...total), last_token_usage: usage(...last), model_context_window: 1000 } } });

const dirs: string[] = [], sources: CodexTranscriptTailer[] = [];
afterEach(() => { vi.useRealTimers(); for (const source of sources) source.stop(); sources.length = 0; for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
async function tail(content: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-codex-usage-')); dirs.push(dir);
  const path = join(dir, `rollout-2026-11-05T10-00-00-${sid}.jsonl`); writeFileSync(path, content);
  const source = new CodexTranscriptTailer({ cwd: dir, transcriptPath: path }); sources.push(source);
  source.start(); await source.flush();
  return { path, source, append: async (text: string) => { appendFileSync(path, text); await source.flush(); } };
}
const take = (source: CodexTranscriptTailer) => source.takeTurnUsage()?.data;

it('reports each turn once, as its own increment, keyed by session and last response; history before the start is not booked', async () => {
  const { source, append } = await tail(meta() + context('gpt-5-codex') + response('resp_old', [500, 0, 5], [500, 0, 5]) + tokenCount([500, 0, 5], [500, 0, 5]));
  expect(source.takeTurnUsage()).toBeUndefined();
  // Turn one: two responses; token_count repeats the same cumulative total, which must not add anything.
  await append(response('resp_1', [1000, 400, 10], [1500, 400, 15]) + tokenCount([1500, 400, 15], [1000, 400, 10]) + tokenCount([1500, 400, 15], [1000, 400, 10])
    + response('resp_2', [2000, 1500, 20], [3500, 1900, 35]) + tokenCount([3500, 1900, 35], [2000, 1500, 20]));
  expect(take(source)).toEqual({ state: 'turn_usage', usageRef: `codex-pty:${sid}:resp_2`, model: 'gpt-5-codex',
    breakdown: { inputTokens: 3000 - 1900, outputTokens: 30, cachedReadTokens: 1900, cachedWriteTokens: 0 } });
  expect(source.takeTurnUsage()).toBeUndefined();
  // Turn two after `codex resume`: the same rollout continues, with the cumulative total carried on.
  await append(meta() + context('gpt-6-astra') + response('resp_3', [3000, 2900, 7], [6500, 4800, 42]) + tokenCount([6500, 4800, 42], [3000, 2900, 7]));
  expect(take(source)).toEqual({ state: 'turn_usage', usageRef: `codex-pty:${sid}:resp_3`, model: 'gpt-6-astra',
    breakdown: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 2900, cachedWriteTokens: 0 } });
});

it('ignores a response it already counted and a response of another thread', async () => {
  const { source, append } = await tail(meta());
  await append(response('resp_1', [100, 0, 1], [100, 0, 1]) + response('resp_1', [100, 0, 1], [100, 0, 1], 9) + response('resp_x', [999, 0, 9], [999, 0, 9], 0, gen));
  expect(take(source)?.breakdown).toEqual({ inputTokens: 100, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0 });
});

it('restores from a checkpoint without booking earlier responses, and re-reading a booked turn yields the same usageRef', async () => {
  const first = await tail(meta() + response('resp_1', [100, 0, 1], [100, 0, 1]));
  const cursor = first.source.checkpoint();
  await first.append(response('resp_2', [200, 50, 2], [300, 50, 3]));
  const booked = take(first.source);
  first.source.stop();
  // A restart restores the earlier durable cursor: resp_2 is read again and reported under the ref already booked.
  const again = new CodexTranscriptTailer({ cwd: dirname(first.path), transcriptPath: first.path }); sources.push(again);
  again.restore(cursor); again.start(); await again.flush();
  expect(take(again)).toEqual(booked);
  expect(booked).toMatchObject({ usageRef: `codex-pty:${sid}:resp_2`, breakdown: { inputTokens: 150, cachedReadTokens: 50, outputTokens: 2 } });
});

it('differences the cumulative total on older rollouts without token_usage_record, skips repeated totals, and never goes negative when it restarts', async () => {
  const { source, append } = await tail(meta() + tokenCount([1000, 0, 10], [1000, 0, 10], '2026-11-05T10:00:00.000Z'));
  // Repeated token_count lines repeat one response; summing last_token_usage would count it twice.
  const second = tokenCount([1500, 100, 15], [500, 100, 5], '2026-11-05T10:00:05.000Z');
  await append(second + second);
  expect(take(source)).toEqual({ state: 'turn_usage', usageRef: `codex-pty:${sid}:2026-11-05T10:00:05.000Z`,
    breakdown: { inputTokens: 400, outputTokens: 5, cachedReadTokens: 100, cachedWriteTokens: 0 } });
  // An earlier reading written again (history copied by a fork or generation) adds nothing.
  await append(tokenCount([1000, 0, 10], [1000, 0, 10], '2026-11-05T10:00:00.000Z'));
  expect(source.takeTurnUsage()).toBeUndefined();
  // The counter restarted (smaller, new total): only that response's own reading counts, marked incomplete.
  await append(tokenCount([300, 0, 3], [300, 0, 3], '2026-11-05T10:01:00.000Z'));
  expect(take(source)).toMatchObject({ partial: true, breakdown: { inputTokens: 300, outputTokens: 3, cachedReadTokens: 0, cachedWriteTokens: 0 } });
  await append(tokenCount([400, 0, 4], [100, 0, 1], '2026-11-05T10:02:00.000Z'));
  expect(take(source)).not.toHaveProperty('partial');
});

it("books only a fork's own responses, not the parent's history copied into it", async () => {
  const parent = '33333333-3333-4333-8333-333333333333';
  const { source, append } = await tail(meta(sid));
  await append(meta(parent) + response('resp_parent', [900, 0, 9], [900, 0, 9], 1, parent) + tokenCount([900, 0, 9], [900, 0, 9]) + response('resp_fork', [50, 0, 5], [50, 0, 5], 2));
  expect(take(source)).toMatchObject({ usageRef: `codex-pty:${sid}:resp_fork`, breakdown: { inputTokens: 50, outputTokens: 5 } });
});

it('does not count a generation handoff that copies earlier responses with new ordinals', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'dd-codex-usage-gen-')); dirs.push(dir);
  writeFileSync(join(dir, 'history.jsonl'), line({ session_id: sid, ts: Date.now() / 1000, text: '<dutydeck_session_id>ses_usage</dutydeck_session_id>' }));
  const segment = (day: string, suffix = '') => {
    const path = join(dir, 'sessions', '2026', '11', day, `rollout-2026-11-${day}T10-00-00-${sid}${suffix}.jsonl`);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, line({ type: 'session_meta', payload: { id: sid, cwd: dir } })); return path;
  };
  const old = segment('04');
  const source = new CodexTranscriptTailer({ cwd: dir, sessionId: 'ses_usage', env: { CODEX_HOME: dir } }); sources.push(source);
  const flush = async () => { vi.advanceTimersByTime(1_001); await source.flush(); };
  source.start(); await flush();
  appendFileSync(old, response('resp_1', [100, 0, 1], [100, 0, 1], 1)); await flush();
  expect(take(source)?.usageRef).toBe(`codex-pty:${sid}:resp_1`);
  appendFileSync(segment('05', `_${gen}`), response('resp_1', [100, 0, 1], [100, 0, 1], 7) + response('resp_2', [40, 0, 4], [140, 0, 5], 8)); await flush();
  expect(take(source)).toMatchObject({ usageRef: `codex-pty:${sid}:resp_2`, breakdown: { inputTokens: 40, outputTokens: 4 } });
});

it('after the counter restarts, a new total equal to one seen before the restart is still counted', async () => {
  const { source, append } = await tail(meta() + tokenCount([1000, 0, 10], [1000, 0, 10], '2026-11-05T10:00:00.000Z'));
  await append(tokenCount([2000, 0, 20], [1000, 0, 10], '2026-11-05T10:00:05.000Z'));
  expect(take(source)?.breakdown).toEqual({ inputTokens: 1000, outputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0 });
  // Restart straight onto a total seen before (new timestamp): a restart, not a copy.
  await append(tokenCount([1000, 0, 10], [1000, 0, 10], '2026-11-05T10:01:00.000Z'));
  expect(take(source)).toMatchObject({ partial: true, breakdown: { inputTokens: 1000, outputTokens: 10 } });
  // Restart again, then the new run climbs back to 1000 and 2000: both increments count.
  await append(tokenCount([300, 0, 3], [300, 0, 3], '2026-11-05T10:02:00.000Z'));
  expect(take(source)).toMatchObject({ partial: true, breakdown: { inputTokens: 300, outputTokens: 3 } });
  await append(tokenCount([1000, 0, 10], [700, 0, 7], '2026-11-05T10:03:00.000Z') + tokenCount([2000, 0, 20], [1000, 0, 10], '2026-11-05T10:04:00.000Z'));
  expect(take(source)).toEqual({ state: 'turn_usage', usageRef: `codex-pty:${sid}:2026-11-05T10:04:00.000Z`,
    breakdown: { inputTokens: 1700, outputTokens: 17, cachedReadTokens: 0, cachedWriteTokens: 0 } });
});

it('without timestamps, repeats and copies within a run are skipped but a new run after a restart counts again', async () => {
  const { source, append } = await tail(meta() + tokenCount([1000, 0, 10], [1000, 0, 10]));
  await append(tokenCount([2000, 0, 20], [1000, 0, 10]) + tokenCount([2000, 0, 20], [1000, 0, 10]) + tokenCount([1000, 0, 10], [1000, 0, 10]));
  expect(take(source)?.breakdown).toEqual({ inputTokens: 1000, outputTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0 });
  await append(tokenCount([300, 0, 3], [300, 0, 3]));
  expect(take(source)).toMatchObject({ partial: true, breakdown: { inputTokens: 300 } });
  await append(tokenCount([1000, 0, 10], [700, 0, 7]));
  expect(take(source)?.breakdown).toEqual({ inputTokens: 700, outputTokens: 7, cachedReadTokens: 0, cachedWriteTokens: 0 });
});
