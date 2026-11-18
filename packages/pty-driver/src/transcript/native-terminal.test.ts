import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexTranscriptTailer, mapCodexEntry } from './codex.js';
import { TraexTranscriptTailer } from './traex.js';
import { CodexToolProjection } from './codex-tools.js';

const dirs: string[] = [];
const sources: CodexTranscriptTailer[] = [];
afterEach(() => { sources.forEach(s => s.stop()); sources.length = 0; dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const record = (type: string, fields: Record<string, unknown> = {}) => ({ type: 'event_msg', payload: { type, turn_id: 'current', ...fields } });
async function source(kind: 'codex' | 'traex') {
  const dir = mkdtempSync(join(tmpdir(), 'dd-native-terminal-')); dirs.push(dir);
  const path = join(dir, 'rollout.jsonl'); writeFileSync(path, '');
  const tail = new (kind === 'codex' ? CodexTranscriptTailer : TraexTranscriptTailer)({ cwd: dir, transcriptPath: path }); sources.push(tail);
  await tail.flush();
  const controller = new AbortController();
  const receipt = tail.waitForInput('question', controller.signal); void receipt.catch(() => {});
  appendFileSync(path, line(record('task_started')) + line(record('user_message', { message: 'question' })));
  await tail.flush(); await receipt;
  return { tail, path, controller };
}

it.each(['codex', 'traex'] as const)('%s binds a textless quota error to the exact input and distinguishes transient rate limits', async kind => {
  const { tail, path } = await source(kind);
  appendFileSync(path, line(record('task_complete', { error: { codex_error_info: 'usage_limit_exceeded', message: 'Usage exhausted' }, last_agent_message: null })));
  await tail.flush();
  expect(tail.hasTurnTerminal?.()).toBe(true);
  expect(tail.takeInputError?.()).toMatchObject({ type: 'error', data: { code: 'usage_limit_exceeded', retryable: false } });
  const receipt = tail.waitForInput('question', new AbortController().signal);
  appendFileSync(path, line(record('task_started', { turn_id: 'next' })) + line(record('user_message', { turn_id: 'next', message: 'question' }))
    + line(record('task_complete', { turn_id: 'next', error: { message: '429 rate limit' } })));
  await tail.flush(); await receipt;
  expect(tail.takeInputError?.()).toMatchObject({ type: 'error', data: { code: 'rate_limit', retryable: true } });
});

it.each(['codex', 'traex'] as const)('%s retains partial text and failure independently after duplicated terminal text', async kind => {
  const { tail, path } = await source(kind);
  const events: unknown[] = []; tail.onEvent(e => events.push(e));
  appendFileSync(path, line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'partial' }] } })
    + line(record('task_complete', { last_agent_message: 'partial', error: { message: 'backend failed' } })));
  await tail.flush();
  expect(events).toHaveLength(1);
  expect(tail.takeInputError?.()).toMatchObject({ type: 'error', data: { code: 'native_task_failed' } });
});

it.each(['codex', 'traex'] as const)('%s rejects old/foreign terminal and cancellation after aborting its input', async kind => {
  const { tail, path, controller } = await source(kind);
  appendFileSync(path, line(record('user_message', { turn_id: 'foreign', message: 'old input' }))
    + line(record('task_complete', { turn_id: 'foreign', error: { message: 'wrong' } })));
  await tail.flush(); expect(tail.takeInputError?.()).toBeUndefined(); expect(tail.hasTurnTerminal?.()).toBe(false);
  const unreceived = tail.waitForInput('unreceived', controller.signal); void unreceived.catch(() => {});
  controller.abort(); await expect(unreceived).rejects.toThrow();
  appendFileSync(path, line(record('task_complete', { error: { message: 'late' } })));
  await tail.flush(); expect(tail.takeInputError?.()).toBeUndefined();
});

it('does not let final text de-duplication discard terminal errors', () => {
  const projection = new CodexToolProjection(mapCodexEntry);
  projection.map({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'partial' }] } });
  expect(projection.map(record('task_complete', { last_agent_message: 'partial', error: { message: 'backend failed' } })))
    .toEqual([{ type: 'error', data: { code: 'native_task_failed', message: 'backend failed', retryable: false } }]);
});

const thread = '01a13e14-124b-7ed1-8708-c4e2255c4022', prompt = '<dutydeck_session_id>ses_native_terminal</dutydeck_session_id>\nquestion';
const user = (text: string) => line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const mirror = (text: string, turn = 'current') => line(record('item_completed', { turn_id: turn, item: { type: 'UserMessage', content: [{ type: 'text', text }] } }));
// Codex 0.162.1 writes AGENTS.md/environment context as user messages before the submitted prompt.
const context = user('# AGENTS.md instructions') + user('<environment_context>x</environment_context>');
const replies = (events: any[]) => events.filter(e => e.type === 'text').map(e => e.data.text);
async function historyFirst() {
  const dir = mkdtempSync(join(tmpdir(), 'dd-native-terminal-')); dirs.push(dir);
  const day = join(dir, 'sessions', '2026', '10', '15'); mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-15T13-41-05-${thread}.jsonl`);
  writeFileSync(path, line({ type: 'session_meta', payload: { id: thread, cwd: dir } })); writeFileSync(join(dir, 'history.jsonl'), '');
  const tail = new CodexTranscriptTailer({ cwd: dir, sessionId: 'ses_native_terminal', env: { CODEX_HOME: dir } }); sources.push(tail);
  const events: any[] = []; tail.onEvent(e => events.push(e));
  await tail.flush();
  const submit = async (text: string) => {
    const receipt = tail.waitForInput(text, new AbortController().signal);
    appendFileSync(join(dir, 'history.jsonl'), line({ session_id: thread, ts: Date.now() / 1000, text }));
    await tail.flush(); await receipt;
  };
  await submit(prompt);
  return { tail, path, events, submit };
}

it.each([
  ['context before the prompt', context + user(prompt) + mirror(prompt)],
  ['a skill injected after the prompt', user(prompt) + mirror(prompt) + user('<skill>\n<name>lint</name>\n</skill>')],
  ['a rollout prompt that differs from history', context + user(prompt + ' ') + mirror(prompt + ' ')],
])('codex settles a history-acknowledged turn with %s', async (_name, inputs) => {
  const { tail, path, events } = await historyFirst();
  appendFileSync(path, line(record('task_started')) + inputs + line(record('task_complete', { last_agent_message: 'done' })));
  await tail.flush();
  expect(tail.hasTurnTerminal?.()).toBe(true);
  expect(replies(events)).toEqual(['done']);
});

it('codex settles a restored turn whose rollout writes context before the prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-native-terminal-')); dirs.push(dir);
  const path = join(dir, 'rollout.jsonl'); writeFileSync(path, '');
  const before = new CodexTranscriptTailer({ cwd: dir, transcriptPath: path }); sources.push(before);
  await before.flush(); const cursor = before.checkpoint(); before.stop();
  const tail = new CodexTranscriptTailer({ cwd: dir, transcriptPath: path }); sources.push(tail);
  const events: any[] = []; tail.onEvent(e => events.push(e));
  tail.restore(cursor);
  appendFileSync(path, line(record('task_started')) + context + user('question') + mirror('question') + line(record('task_complete', { last_agent_message: 'done' })));
  await tail.flush();
  expect(tail.hasTurnTerminal?.()).toBe(true);
  expect(replies(events)).toEqual(['done']);
});

it('codex binds the next native turn only to its own terminal', async () => {
  const { tail, path, events, submit } = await historyFirst();
  appendFileSync(path, line(record('task_started')) + context + user(prompt) + line(record('task_complete', { last_agent_message: 'done' })));
  await tail.flush();
  await submit('second');
  appendFileSync(path, line(record('task_complete', { last_agent_message: 'stale' }))
    + line(record('task_started', { turn_id: 'next' })) + user('<environment_context>y</environment_context>') + user('second'));
  await tail.flush();
  expect(tail.hasTurnTerminal?.()).toBe(false);
  appendFileSync(path, line(record('task_complete', { turn_id: 'next', last_agent_message: 'done2' })));
  await tail.flush();
  expect(tail.hasTurnTerminal?.()).toBe(true);
  expect(replies(events)).toEqual(['done', 'done2']);
});

it('codex drops a turn superseded by a different input in a newer native turn', async () => {
  const { tail, path, events } = await historyFirst();
  appendFileSync(path, line(record('task_started')) + user(prompt) + mirror(prompt)
    + line(record('task_started', { turn_id: 'typed' })) + user('typed directly') + line(record('task_complete', { last_agent_message: 'late' })));
  await tail.flush();
  expect(tail.hasTurnTerminal?.()).toBe(false);
  expect(replies(events)).toEqual([]);
});
