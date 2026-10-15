import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { codexInputText } from './input-receipt.js';
import { TraexTranscriptTailer } from './traex.js';

const sources: TraexTranscriptTailer[] = [], dirs: string[] = [];
afterEach(() => { sources.splice(0).forEach(s => s.stop()); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const thread = 'native-thread', turn = 'native-turn';
const mutation = (item: unknown, threadId = thread, turnId = turn) => ({ type: 'history_mutation', payload: { operation: 'append', turn_id: turn,
  display_completions: [{ thread_id: threadId, turn_id: turnId, item }] } });
const user = (type: string) => ({ type: 'UserMessage', content: [{ type, text: 'question\r\nsecond line' }] });
const terminal = (outcome: string) => ({ type: 'event_msg', payload: { type: outcome === 'cancelled' ? 'turn_aborted' : 'task_complete', turn_id: turn,
  last_agent_message: '', ...(outcome === 'failed' ? { error: { message: 'backend failed' } } : {}) } });
async function fixture(recovery: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-traex-input-binding-')); dirs.push(dir);
  const path = join(dir, 'rollout.jsonl'); writeFileSync(path, line({ type: 'session_meta', payload: { id: thread } }));
  const create = () => { const source = new TraexTranscriptTailer({ cwd: dir, transcriptPath: path }); sources.push(source); return source; };
  let source = create(); await source.flush();
  if (recovery) {
    appendFileSync(path, line(mutation(user('Text')))); await source.flush();
    const cursor = source.checkpoint(); source.stop(); source = create(); source.restore(cursor);
    appendFileSync(path, line(terminal('failed'))); await source.flush();
    // Replayed input before the durable cursor cannot authorize a later terminal.
    expect(source.hasTurnTerminal()).toBe(false); expect(source.takeInputError()).toBeUndefined();
  }
  const events: NormalizedDriverEvent[] = []; source.onEvent(e => events.push(e));
  return { source, path, events };
}
const cases = ['text', 'input_text', 'Text', 'output_text'].flatMap(type => [false, true].flatMap(recovery =>
  ['success', 'failed', 'cancelled'].map(outcome => ({ type, recovery, outcome }))));
it.each(cases)('binds $type after recovery=$recovery and preserves $outcome terminal authority', async ({ type, recovery, outcome }) => {
  const h = await fixture(recovery);
  const receipt = recovery ? undefined : h.source.waitForInput('question\nsecond line', new AbortController().signal);
  appendFileSync(h.path, line(mutation(user(type)))
    + (outcome === 'cancelled' ? '' : line(mutation({ type: 'AgentMessage', id: 'reply', phase: 'final_answer', content: [{ type: 'Text', text: 'answer' }] })))
    + line(terminal(outcome)));
  await h.source.flush(); await receipt;
  expect(h.source.hasTurnTerminal()).toBe(true);
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(outcome === 'cancelled' ? [] : ['answer']);
  expect(h.source.takeInputError()).toEqual(outcome === 'failed' ? expect.objectContaining({ data: expect.objectContaining({ message: 'backend failed' }) }) : undefined);
  expect(h.source.takeInputCancellation()).toBe(outcome === 'cancelled');
  expect(h.source.takeInputError()).toBeUndefined(); expect(h.source.takeInputCancellation()).toBe(false);
});

it.each([false, true])('rejects foreign, assistant, model-injected and empty inputs after recovery=%s', async recovery => {
  const h = await fixture(recovery), controller = new AbortController(); let accepted = false;
  const receipt = recovery ? undefined : h.source.waitForInput('question\nsecond line', controller.signal).then(() => { accepted = true; });
  void receipt?.catch(() => {});
  const invalid = [mutation(user('Text'), 'foreign'), mutation(user('output_text'), thread, 'foreign-turn'),
    mutation({ ...user('Text'), role: 'assistant' }), mutation({ ...user('output_text'), role: 'tool' }),
    mutation({ type: 'AgentMessage', role: 'assistant', content: [{ type: 'Text', text: 'question\r\nsecond line' }] }),
    { type: 'history_mutation', payload: { operation: 'append', turn_id: turn,
      items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'question\r\nsecond line' }] }] } },
    ...[[], '', [{ type: 'Text', text: '' }], [{ type: 'image', text: 'question\r\nsecond line' }]].map(content => mutation({ type: 'UserMessage', content }))];
  for (const entry of invalid) {
    appendFileSync(h.path, line(entry) + line(terminal('failed')) + line(terminal('cancelled')));
    await h.source.flush();
    expect(accepted).toBe(false); expect(h.source.hasTurnTerminal()).toBe(false);
    expect(h.source.takeInputError()).toBeUndefined(); expect(h.source.takeInputCancellation()).toBe(false);
  }
  appendFileSync(h.path, line(mutation(user('Text'))) + line(terminal('success')));
  await h.source.flush(); await receipt; expect(h.source.hasTurnTerminal()).toBe(true);
});

it('keeps Codex input recognition restricted to its own text block dialect', () => {
  for (const type of ['Text', 'output_text']) {
    expect(codexInputText({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type, text: 'question' }] } })).toBeUndefined();
    expect(codexInputText(mutation(user(type)))).toBeUndefined();
  }
});
