import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { TraexTranscriptTailer } from './traex.js';
const thread = 'native-thread', turn = 'native-turn';
const dirs: string[] = [], sources: TraexTranscriptTailer[] = [];
afterEach(() => { sources.forEach(s => s.stop()); sources.length = 0; dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });
const line = (record: unknown) => JSON.stringify(record) + '\n';
const canonical = (item: unknown, overrides: Record<string, unknown> = {}) => ({ type: 'history_mutation', payload: { operation: 'append', turn_id: turn,
  items: [], display_completions: [{ thread_id: thread, turn_id: turn, item, ...overrides }] } });
const user = canonical({ type: 'UserMessage', id: 'user', content: [{ type: 'text', text: 'question' }] });
const agent = (phase?: string, text = 'answer') => canonical({ type: 'AgentMessage', id: 'message', phase, content: [{ type: 'Text', text }] });
const terminal = (extra: Record<string, unknown> = {}) => ({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: '', ...extra } });
async function fixture(threadId = thread) {
  const dir = mkdtempSync(join(tmpdir(), 'dd-canonical-')); dirs.push(dir);
  const path = join(dir, 'rollout.jsonl'); writeFileSync(path, line({ type: 'session_meta', payload: { id: threadId } }));
  const source = new TraexTranscriptTailer({ cwd: dir, transcriptPath: path }); sources.push(source);
  const events: NormalizedDriverEvent[] = []; source.onEvent(e => events.push(e)); await source.flush();
  return { path, source, events };
}

it('acknowledges canonical-only input and preserves final Markdown with an empty terminal and failed outcome', async () => {
  const h = await fixture(); const receipt = h.source.waitForInput('question', new AbortController().signal);
  const markdown = '| A | B |\n| --- | --- |\n| 好 | 👩‍💻 |\n\n```ts\nconst n = 1;\n```';
  appendFileSync(h.path, line(user) + line(agent('final_answer', markdown)) + line(terminal({ error: { message: 'failed after partial output' } })));
  await h.source.flush(); await receipt;
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual([markdown]);
  expect(h.source.hasTurnTerminal()).toBe(true);
  expect(h.source.takeInputError()).toMatchObject({ data: { message: 'failed after partial output' } });
});

it('ignores foreign thread/turn inputs and injected model user records as receipts', async () => {
  const h = await fixture(), controller = new AbortController(); let accepted = false;
  const receipt = h.source.waitForInput('question', controller.signal).then(() => { accepted = true; }); void receipt.catch(() => {});
  appendFileSync(h.path, line(canonical({ type: 'UserMessage', content: [{ type: 'text', text: 'question' }] }, { thread_id: 'foreign' }))
    + line(canonical({ type: 'UserMessage', content: [{ type: 'text', text: 'question' }] }, { turn_id: 'foreign' }))
    + line({ type: 'history_mutation', payload: { operation: 'append', turn_id: turn, items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'question' }] }] } }));
  await h.source.flush(); expect(accepted).toBe(false);
  appendFileSync(h.path, line(user)); await h.source.flush(); await receipt;
  appendFileSync(h.path, line(canonical({ type: 'AgentMessage', phase: 'final', content: [{ type: 'text', text: 'foreign answer' }] }, { thread_id: 'foreign' }))
    + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'old-turn', last_agent_message: 'old answer', error: { message: 'old error' } } }));
  await h.source.flush(); expect(h.events).toEqual([]); expect(h.source.hasTurnTerminal()).toBe(false); expect(h.source.takeInputError()).toBeUndefined();
});

it.each([true, false])('keeps commentary distinct from phase-less mirrors (explicit phase first: %s)', async phaseFirst => {
  const h = await fixture(); const receipt = h.source.waitForInput('question', new AbortController().signal);
  const explicit = agent('commentary', 'progress'), mirror = agent(undefined, 'progress');
  appendFileSync(h.path, line(user) + line(phaseFirst ? explicit : mirror) + line(phaseFirst ? mirror : explicit)
    + line(agent('final_answer', 'final')) + line(terminal({ last_agent_message: 'final' })));
  await h.source.flush(); await receipt;
  expect(h.events.filter(e => e.type === 'thinking').map(e => e.data)).toEqual([{ text: 'progress', phase: 'commentary' }]);
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(['final']);
});

it('recovers phase-less final at terminal and deduplicates mixed legacy/canonical mirrors', async () => {
  const h = await fixture(); const receipt = h.source.waitForInput('question', new AbortController().signal);
  appendFileSync(h.path, line(user) + line(agent()) + line({ type: 'event_msg', payload: { type: 'item_completed', turn_id: turn,
    item: { type: 'AgentMessage', id: 'message', text: 'answer' } } }) + line(terminal()));
  await h.source.flush(); await receipt;
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(['answer']);
});

it('prefers canonical reasoning summaries over same-item raw text and normalizes array tool outputs', async () => {
  const h = await fixture();
  const entry = { type: 'history_mutation', payload: { operation: 'append', turn_id: turn,
    items: [{ type: 'reasoning', id: 'reason', content: [{ type: 'reasoning_text', text: 'raw model' }] },
      { type: 'function_call', call_id: 'tool', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'tool', output: [{ type: 'Text', text: '/tmp\nfixture' }] }],
    display_completions: [{ thread_id: thread, turn_id: turn, item: { type: 'Reasoning', id: 'reason', summary_text: ['visible summary'], raw_content: ['raw canonical'] } }] } };
  appendFileSync(h.path, line(entry) + line(entry)); await h.source.flush();
  expect(h.events.map(e => e.type)).toEqual(['thinking', 'tool_call', 'tool_result']);
  expect(h.events[0]?.data.text).toBe('visible summary'); expect(h.events[2]?.data.output).toBe('/tmp\nfixture');
});

it('replays the recorded TraeX 0.209.1 rollout as exactly two final replies', async () => {
  // Extracted rollout records only from Botmux 81f978251, MIT licensed,
  // test/fixtures/traex-tape/two-turns.json (recordedWith: TraeX 0.209.1).
  const records = readFileSync(new URL('./fixtures/traex-0.209.1-rollout.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const id = records.find(r => r.type === 'history_mutation').payload.display_completions[0].thread_id;
  const h = await fixture(id);
  for (const record of records) { appendFileSync(h.path, line(record)); await h.source.flush(); }
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(['好', '行']);
});


it('deduplicates an explicit legacy response-item final and canonical mirror of the same item', async () => {
  const h = await fixture(); const receipt = h.source.waitForInput('question', new AbortController().signal);
  appendFileSync(h.path, line(user) + line({ type: 'response_item', payload: { type: 'message', role: 'assistant', turn_id: turn, id: 'message', phase: 'final', content: [{ type: 'output_text', text: 'answer' }] } })
    + line(agent('final_answer')) + line(terminal({ last_agent_message: 'answer' })));
  await h.source.flush(); await receipt;
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(['answer']);
});

it('retains the same text and item ID when they belong to a different native turn', async () => {
  const h = await fixture();
  for (const id of [turn, 'next-turn']) {
    const receipt = h.source.waitForInput('question', new AbortController().signal);
    const records = [user, agent('final'), terminal({ last_agent_message: 'answer' })].map(record => {
      const copy = structuredClone(record); copy.payload.turn_id = id;
      if ('display_completions' in copy.payload) for (const completion of copy.payload.display_completions) completion.turn_id = id;
      return copy;
    });
    appendFileSync(h.path, records.map(line).join('')); await h.source.flush(); await receipt;
  }
  expect(h.events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(['answer', 'answer']);
});
