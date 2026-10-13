import { afterEach, expect, it } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ClaudeTranscriptTailer } from './claude.js';

let directory: string, source: ClaudeTranscriptTailer;
afterEach(() => { source?.stop(); if (directory) rmSync(directory, { recursive: true, force: true }); });
const fixture = fileURLToPath(new URL('./fixtures/claude-subagents/', import.meta.url));
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const message = (id: string, model: string, usage: Record<string, number>) =>
  ({ type: 'assistant', isSidechain: true, uuid: `uuid_${id}_${Math.random()}`, message: { id, role: 'assistant', model, content: [{ type: 'text', text: 'x' }], usage } });
const sidechain = (name: string) => join(directory, 'session', 'subagents', name);

/** A tailer on <tmp>/session.jsonl, started when `before` has been laid out (those files are earlier turns). */
async function tail(before?: () => void, restore = false) {
  directory = mkdtempSync(join(tmpdir(), 'dd-claude-subagent-usage-'));
  const path = join(directory, 'session.jsonl'); writeFileSync(path, '');
  before?.();
  source = new ClaudeTranscriptTailer({ cwd: directory, transcriptPath: path });
  if (restore) source.restore({ path, offset: 0 });
  source.start(); await source.flush();
  return { path, main: async (...entries: unknown[]) => { appendFileSync(path, entries.map(line).join('')); await source.flush(); } };
}
const startAgent = (name: string, ...entries: unknown[]) => {
  mkdirSync(join(directory, 'session', 'subagents'), { recursive: true });
  writeFileSync(sidechain(name), entries.map(line).join(''));
};
const opus = (id: string, input: number) => ({ type: 'assistant', uuid: `uuid_${id}`, message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: 1 } } });

it('counts the main transcript and every sub-agent file of a Claude Code 2.1.x session once, split by model', async () => {
  const { path } = await tail();
  cpSync(join(fixture, 'session.jsonl'), path); cpSync(join(fixture, 'session'), join(directory, 'session'), { recursive: true });
  await source.flush();
  const event = source.takeTurnUsage();
  // msg_a_1 is written first with zero usage and repeated in agent B's file; the workflow journal is not an agent transcript.
  expect(event).toEqual({ type: 'status', data: {
    state: 'turn_usage', usageRef: 'claude:msg_w_1', model: 'claude-haiku-5-5 + claude-opus-5-5 + claude-sonnet-5-5',
    breakdown: { inputTokens: 2080, outputTokens: 895, cachedReadTokens: 93100, cachedWriteTokens: 5500 },
    byModel: [
      { model: 'claude-haiku-5-5', breakdown: { inputTokens: 360, outputTokens: 105, cachedReadTokens: 17100, cachedWriteTokens: 1000 } },
      { model: 'claude-opus-5-5', breakdown: { inputTokens: 1020, outputTokens: 700, cachedReadTokens: 64000, cachedWriteTokens: 4000 } },
      { model: 'claude-sonnet-5-5', breakdown: { inputTokens: 700, outputTokens: 90, cachedReadTokens: 12000, cachedWriteTokens: 500 } },
    ],
  } });
  expect(source.takeTurnUsage()).toBeUndefined();
});

it('counts a new sub-agent file and the lines appended to a growing one, each only once across turns', async () => {
  const { main } = await tail();
  await main(opus('msg_m1', 100));
  startAgent('agent-a.jsonl', message('msg_a1', 'claude-haiku-5-5', { input_tokens: 10, output_tokens: 2 }));
  expect(source.takeTurnUsage()?.data.breakdown).toMatchObject({ inputTokens: 110, outputTokens: 3 });
  appendFileSync(sidechain('agent-a.jsonl'), line(message('msg_a2', 'claude-haiku-5-5', { input_tokens: 20, output_tokens: 4 })));
  startAgent('agent-b.jsonl', message('msg_b1', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 1 }));
  const second = source.takeTurnUsage()?.data;
  expect(second?.breakdown).toMatchObject({ inputTokens: 25, outputTokens: 5 });
  expect(second?.partial).toBeUndefined();
  expect(source.takeTurnUsage()).toBeUndefined();
});

it('does not count a forked agent that repeats records already reported in an earlier turn', async () => {
  const { main } = await tail();
  await main(opus('msg_m1', 100));
  startAgent('agent-a.jsonl', message('msg_a1', 'claude-haiku-5-5', { input_tokens: 10, output_tokens: 2 }));
  expect(source.takeTurnUsage()?.data.breakdown.inputTokens).toBe(110);
  startAgent('agent-fork.jsonl', message('msg_a1', 'claude-haiku-5-5', { input_tokens: 10, output_tokens: 2 }), message('msg_f1', 'claude-haiku-5-5', { input_tokens: 7, output_tokens: 1 }));
  expect(source.takeTurnUsage()?.data.breakdown.inputTokens).toBe(7);
});

it('treats sub-agent files that already existed when tailing began as earlier turns', async () => {
  const { main } = await tail(() => {
    mkdirSync(join(directory, 'session', 'subagents'), { recursive: true });
    writeFileSync(sidechain('agent-old.jsonl'), line(message('msg_old', 'claude-haiku-5-5', { input_tokens: 999, output_tokens: 9 })));
  });
  await main(opus('msg_m1', 100));
  expect(source.takeTurnUsage()?.data.breakdown.inputTokens).toBe(100);
  appendFileSync(sidechain('agent-old.jsonl'), line(message('msg_new', 'claude-haiku-5-5', { input_tokens: 3, output_tokens: 1 })));
  expect(source.takeTurnUsage()?.data.breakdown.inputTokens).toBe(3);
});

it('waits for the end of a line the sub-agent is still writing instead of failing on it', async () => {
  const { main } = await tail();
  await main(opus('msg_m1', 100));
  const full = line(message('msg_a1', 'claude-haiku-5-5', { input_tokens: 10, output_tokens: 2 }));
  startAgent('agent-a.jsonl'); writeFileSync(sidechain('agent-a.jsonl'), full.slice(0, 40));
  expect(source.takeTurnUsage()?.data).toMatchObject({ breakdown: { inputTokens: 100 } });
  appendFileSync(sidechain('agent-a.jsonl'), full.slice(40));
  expect(source.takeTurnUsage()?.data).toMatchObject({ breakdown: { inputTokens: 10 } });
  expect(source.takeTurnUsage()).toBeUndefined();
});

it('marks the reading partial when a sub-agent file cannot be read or understood, and only for that turn', async () => {
  const { main } = await tail();
  await main(opus('msg_m1', 100));
  startAgent('agent-bad.jsonl', '{ not json');
  appendFileSync(sidechain('agent-bad.jsonl'), '\n');
  const malformed = source.takeTurnUsage()?.data;
  expect(malformed).toMatchObject({ breakdown: { inputTokens: 100 }, partial: true });

  await main(opus('msg_m2', 1));
  appendFileSync(sidechain('agent-bad.jsonl'), line({ type: 'assistant', isSidechain: true, message: { id: 'msg_nousage', role: 'assistant', model: 'claude-haiku-5-5', content: [] } }));
  expect(source.takeTurnUsage()?.data).toMatchObject({ breakdown: { inputTokens: 1 }, partial: true });

  await main(opus('msg_m3', 2));
  expect(source.takeTurnUsage()?.data.partial).toBeUndefined();
});

it('marks the reading partial when the sub-agent directory cannot be listed', async () => {
  const { main } = await tail(() => writeFileSync(join(directory, 'session'), 'not a directory'));
  await main(opus('msg_m1', 100));
  expect(source.takeTurnUsage()?.data).toMatchObject({ breakdown: { inputTokens: 100 }, partial: true });
});

it('marks the first reading of a restored tailer partial when sub-agent files exist, since it cannot tell which are this turn\'s', async () => {
  const { main } = await tail(() => {
    mkdirSync(join(directory, 'session', 'subagents'), { recursive: true });
    writeFileSync(sidechain('agent-old.jsonl'), line(message('msg_old', 'claude-haiku-5-5', { input_tokens: 999, output_tokens: 9 })));
  }, true);
  await main(opus('msg_m1', 100));
  expect(source.takeTurnUsage()?.data).toMatchObject({ breakdown: { inputTokens: 100 }, partial: true });
  await main(opus('msg_m2', 1));
  expect(source.takeTurnUsage()?.data.partial).toBeUndefined();
});

it('keeps the legacy shape working: isSidechain lines inside the main transcript are counted', async () => {
  const { main } = await tail();
  await main(opus('msg_m1', 100), message('msg_side', 'claude-haiku-5-5', { input_tokens: 5, output_tokens: 1 }));
  expect(source.takeTurnUsage()?.data).toMatchObject({ model: 'claude-haiku-5-5 + claude-opus-5-5', breakdown: { inputTokens: 105 }, byModel: expect.any(Array) });
});
