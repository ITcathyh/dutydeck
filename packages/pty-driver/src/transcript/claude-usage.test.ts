import { afterEach, expect, it } from 'vitest';
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ClaudeTranscriptTailer, claudeMessageUsage } from './claude.js';

let directory: string, source: ClaudeTranscriptTailer;
afterEach(() => { source?.stop(); if (directory) rmSync(directory, { recursive: true, force: true }); });
const fixture = new URL('./fixtures/claude-usage.jsonl', import.meta.url);
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const message = (id: string, model: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', uuid: `uuid_${id}`, ...extra, message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'x' }], usage } });

async function tail(content = '') {
  directory = mkdtempSync(join(tmpdir(), 'dd-claude-usage-'));
  const path = join(directory, 'session.jsonl'); writeFileSync(path, content);
  source = new ClaudeTranscriptTailer({ cwd: directory, transcriptPath: path });
  source.start(); await source.flush();
  return { path, append: async (...entries: unknown[]) => { appendFileSync(path, entries.map(line).join('')); await source.flush(); } };
}

it('reports one turn_usage from a real-shaped transcript: de-duplicated by message id, synthetic placeholders excluded', async () => {
  const { path } = await tail();
  copyFileSync(fileURLToPath(fixture), path); await source.flush();
  const event = source.takeTurnUsage();
  expect(event).toEqual({ type: 'status', data: {
    state: 'turn_usage', usageRef: 'claude:msg_fix_2', model: 'claude-opus-5-5',
    // msg_fix_1 appears on three lines but is one API call: 1200+30 input, 300+800 output, 40000+45000 cache read, 5000 cache write.
    breakdown: { inputTokens: 1230, outputTokens: 1100, cachedReadTokens: 85000, cachedWriteTokens: 5000 }
  } });
  expect(source.takeTurnUsage()).toBeUndefined();
});

it('keeps the largest reading when a streamed message is written more than once', async () => {
  const { append } = await tail();
  await append(message('msg_1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 3 }), message('msg_1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 90, cache_read_input_tokens: 7 }));
  expect(source.takeTurnUsage()?.data.breakdown).toEqual({ inputTokens: 10, outputTokens: 90, cachedReadTokens: 7, cachedWriteTokens: 0 });
});

it('counts sub-agent (sidechain) messages and names several models together instead of picking one', async () => {
  const { append } = await tail();
  await append(message('msg_main', 'claude-opus-5-5', { input_tokens: 100, output_tokens: 10 }), message('msg_side', 'claude-haiku-4-5', { input_tokens: 5, output_tokens: 1 }, { isSidechain: true }));
  expect(source.takeTurnUsage()?.data).toMatchObject({ model: 'claude-haiku-4-5 + claude-opus-5-5', breakdown: { inputTokens: 105, outputTokens: 11 } });
});

it('totals a large same-model batch with interleaved models without changing an earlier reading', async () => {
  const { append } = await tail();
  const batch = Array.from({ length: 2048 }, (_, index) => message(`msg_${index}`, 'claude-opus-5-5', {
    input_tokens: index + 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
  }));
  await append(
    message('msg_first', 'claude-haiku-4-5', { input_tokens: 7, output_tokens: 11 }),
    ...batch.slice(0, 1024),
    message('msg_unknown', '', { input_tokens: 13, output_tokens: 17 }),
    ...batch.slice(1024),
    message('msg_last', 'claude-haiku-4-5', { input_tokens: 19, output_tokens: 23 }),
  );
  const event = source.takeTurnUsage();
  const expected = { type: 'status', data: {
    state: 'turn_usage', usageRef: 'claude:msg_last', model: 'claude-haiku-4-5 + claude-opus-5-5',
    breakdown: { inputTokens: 2098215, outputTokens: 4147, cachedReadTokens: 6144, cachedWriteTokens: 8192 },
    byModel: [
      { breakdown: { inputTokens: 13, outputTokens: 17, cachedReadTokens: 0, cachedWriteTokens: 0 } },
      { model: 'claude-haiku-4-5', breakdown: { inputTokens: 26, outputTokens: 34, cachedReadTokens: 0, cachedWriteTokens: 0 } },
      { model: 'claude-opus-5-5', breakdown: { inputTokens: 2098176, outputTokens: 4096, cachedReadTokens: 6144, cachedWriteTokens: 8192 } },
    ],
  } };
  expect(event).toEqual(expected);
  expect(source.takeTurnUsage()).toBeUndefined();
  await append(message('msg_next', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 2 }));
  expect(source.takeTurnUsage()).toEqual({ type: 'status', data: {
    state: 'turn_usage', usageRef: 'claude:msg_next', model: 'claude-opus-5-5',
    breakdown: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0 },
  } });
  expect(event).toEqual(expected);
});

it('does not report the same message again after the transcript is re-read', async () => {
  const { append } = await tail();
  await append(message('msg_1', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }));
  expect(source.takeTurnUsage()).toBeDefined();
  await append(message('msg_1', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 }));
  expect(source.takeTurnUsage()).toBeUndefined();
});

it('reports nothing, not zeros, when the transcript carries no usage', async () => {
  const { append } = await tail();
  await append({ type: 'assistant', uuid: 'a', message: { id: 'msg_none', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }] } },
    { type: 'user', uuid: 'u', message: { role: 'user', content: 'hi' } });
  expect(source.takeTurnUsage()).toBeUndefined();
  expect(claudeMessageUsage({ type: 'assistant', isApiErrorMessage: true, message: { id: 'm', model: 'claude-opus-5-5', usage: { input_tokens: 1 } } })).toBeUndefined();
});
