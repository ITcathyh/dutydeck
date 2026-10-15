import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
