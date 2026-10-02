import { afterEach, afterAll, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { mapCodexEntry, CodexTranscriptTailer } from './codex.js';
import { mapTraexEntry, TraexTranscriptTailer } from './traex.js';

// Real 0.159.3/0.208.1-alpha.5 event shapes; IDs, commands, cwd and outputs
// are replaced with fixture values. The fixture retains native field names.
const records = JSON.parse(readFileSync(new URL('./fixtures/native-tools.json', import.meta.url), 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'dd-native-tools-'));
const sources: { stop(): void }[] = [];
afterEach(() => { for (const source of sources.splice(0)) source.stop(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const command = (id: string, status = 'completed', exitCode = 0, source = 'unified_exec_startup') => ({
  ...records[0], payload: { ...records[0].payload, item: { ...records[0].payload.item, id, status, exit_code: exitCode, source } },
});
const wrapper = (id: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input: 'await tools.exec_command({cmd:"printf fixture"});' } });
const wrapperEnd = (id: string) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: id, output: 'Script completed' } });
const final = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] } });
const complete = (text: string) => ({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: text } });

it.each([mapCodexEntry, mapTraexEntry])('projects native commands, changes, MCP and collaboration without completing a turn', mapper => {
  const events = records.flatMap((entry: unknown) => mapper(entry) ?? []);
  expect(events.map((event: NormalizedDriverEvent) => event.type)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result']);
  expect(events.filter((event: NormalizedDriverEvent) => event.type === 'tool_call').map((event: NormalizedDriverEvent) => event.data.name)).toEqual(['exec_command', 'apply_patch', 'fixture.lookup', 'wait']);
  expect(events[1].data).toMatchObject({ output: 'fixture\n', status: 'completed', exitCode: 0 });
  expect(events[3].data).toMatchObject({ output: 'write refused', status: 'failed' });
  expect(mapper(command('failed-command', 'completed', 7))?.[1]?.data.status).toBe('failed');
  expect(mapper({ ...records[2], payload: { type: 'item_completed', item: { ...records[2].payload.item, error: { message: 'fixture error' }, result: null } } })?.[1]?.data.status).toBe('failed');
  expect(mapper({ ...records[3], payload: { type: 'item_completed', item: { ...records[3].payload.item, status: 'failed' } } })?.[1]?.data.status).toBe('failed');
});

for (const Tailer of [CodexTranscriptTailer, TraexTranscriptTailer]) {
  it(`${Tailer.name}: deduplicates only same native ID across legacy/modern incremental records and restore`, async () => {
    const path = join(directory, `${Tailer.name}-mixed.jsonl`); writeFileSync(path, '');
    const source = new Tailer({ cwd: directory, transcriptPath: path }); sources.push(source);
    const events: NormalizedDriverEvent[] = []; source.onEvent(event => events.push(event)); await source.flush();
    const legacy = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'same', arguments: '{"cmd":"printf fixture"}' } };
    appendFileSync(path, line(legacy)); await source.flush(); const cursor = source.checkpoint(); source.stop();
    const restored = new Tailer({ cwd: directory, transcriptPath: path }); sources.push(restored); restored.restore(cursor); restored.onEvent(event => events.push(event));
    const next = line(command('same')) + line(command('different'));
    appendFileSync(path, next.slice(0, next.length - 10)); await restored.flush();
    appendFileSync(path, next.slice(next.length - 10)); await restored.flush(); await restored.flush();
    expect(events.filter(event => event.type === 'tool_call').map(event => event.data.id)).toEqual(['same', 'different']);
    expect(events.filter(event => event.type === 'tool_result').map(event => event.data.id)).toEqual(['same', 'different']);
    appendFileSync(path, line(command('modern-first')) + line({ ...legacy, payload: { ...legacy.payload, call_id: 'modern-first' } })); await restored.flush();
    expect(events.filter(event => event.type === 'tool_call' && event.data.id === 'modern-first')).toHaveLength(1);
  });
}

it('suppresses a single exec wrapper around two distinct commands, restores across the wrapper boundary and keeps legacy fallback', async () => {
  const path = join(directory, 'wrapper.jsonl'); writeFileSync(path, '');
  const first = new CodexTranscriptTailer({ cwd: directory, transcriptPath: path }); sources.push(first); await first.flush();
  appendFileSync(path, line(wrapper('wrapper'))); await first.flush(); const cursor = first.checkpoint(); first.stop();
  const restored = new CodexTranscriptTailer({ cwd: directory, transcriptPath: path }); sources.push(restored); restored.restore(cursor);
  const events: NormalizedDriverEvent[] = []; restored.onEvent(event => events.push(event));
  appendFileSync(path, line(command('one')) + line(command('two')) + line(wrapperEnd('wrapper'))); await restored.flush();
  expect(events.filter(event => event.type === 'tool_call').map(event => event.data.id)).toEqual(['one', 'two']);
  appendFileSync(path, line(wrapper('legacy')) + line(wrapperEnd('legacy'))); await restored.flush();
  expect(events.slice(-2).map(event => [event.type, event.data.id])).toEqual([['tool_call', 'legacy'], ['tool_result', 'legacy']]);
  appendFileSync(path, line(wrapper('a')) + line(wrapper('b')) + line(command('ambiguous')) + line(wrapperEnd('a')) + line(wrapperEnd('b'))); await restored.flush();
  expect(events.filter(event => event.type === 'tool_call').map(event => event.data.id)).toEqual(['one', 'two', 'legacy', 'ambiguous', 'a', 'b']);
  appendFileSync(path, line(wrapper('non-unified')) + line(command('independent', 'completed', 0, 'user')) + line(wrapperEnd('non-unified'))); await restored.flush();
  expect(events.filter(event => event.type === 'tool_call').slice(-2).map(event => event.data.id)).toEqual(['independent', 'non-unified']);
});

it('suppresses only a same-turn task_complete mirror of an explicit final, including cursor restore', async () => {
  const path = join(directory, 'final.jsonl'); writeFileSync(path, '');
  const first = new CodexTranscriptTailer({ cwd: directory, transcriptPath: path }); sources.push(first); await first.flush();
  const events: NormalizedDriverEvent[] = []; first.onEvent(event => events.push(event));
  appendFileSync(path, line(final('same'))); await first.flush(); const cursor = first.checkpoint(); first.stop();
  const restored = new CodexTranscriptTailer({ cwd: directory, transcriptPath: path }); sources.push(restored); restored.restore(cursor); restored.onEvent(event => events.push(event));
  appendFileSync(path, line(complete('same'))); await restored.flush();
  appendFileSync(path, line({ type: 'event_msg', payload: { type: 'task_started' } }) + line(complete('same'))); await restored.flush();
  appendFileSync(path, line(final('old')) + line(complete('different'))); await restored.flush();
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['same', 'same', 'old', 'different']);
});
