import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TraexTranscriptTailer, resolveTraexRolloutPath } from './traex.js';
import type { NormalizedDriverEvent } from '@dutydeck/shared';

const thread = '11111111-1111-4111-8111-111111111111';
const foreign = '99999999-9999-4999-8999-999999999999';
const turn = '22222222-2222-4222-8222-222222222222';
const dirs: string[] = [], sources: TraexTranscriptTailer[] = [];
afterEach(() => { sources.forEach(s => s.stop()); sources.length = 0; dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const answer = (text: string) => line({ type: 'event_msg', payload: { type: 'agent_message', phase: 'final', message: text } });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dd-segments-')); dirs.push(directory);
  mkdirSync(join(directory, 'cli'), { recursive: true });
  writeFileSync(join(directory, 'cli', 'history.jsonl'), line({ session_id: thread, ts: Date.now() / 1000, text: 'ses_segment-fixture' }));
  const opts = { cwd: directory, env: { TRAE_HOME: directory }, sessionId: 'ses_segment-fixture' };
  const segment = (day: string, stamp: string, id = thread, suffix = '') => {
    const path = join(directory, 'cli', 'sessions', '2026', '10', day, `rollout-2026-10-${day}T${stamp}-${id}${suffix}.jsonl`);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, line({ type: 'session_meta', payload: { id, cwd: directory } })); return path;
  };
  const source = () => { const s = new TraexTranscriptTailer(opts); sources.push(s); return s; };
  return { opts, segment, source };
}

it('selects the latest verified segment of the bound thread, rather than its old unsuffixed file or another thread', () => {
  const h = fixture(); h.segment('14', '10-00-00');
  const latest = h.segment('15', '10-00-00', thread, `_${turn}`);
  h.segment('16', '10-00-00', foreign, `_${turn}`);
  expect(resolveTraexRolloutPath(h.opts.cwd, h.opts.env, h.opts.sessionId)).toBe(latest);
});

it('drains the old partial line before all adjacent and cross-day segments, without losing new-segment bytes', async () => {
  const h = fixture(), old = h.segment('14', '10-00-00'), source = h.source();
  const events: NormalizedDriverEvent[] = []; source.onEvent(e => events.push(e)); await source.flush();
  appendFileSync(old, answer('old').trimEnd());
  const next = h.segment('14', '11-00-00', thread, `_${turn}`); appendFileSync(next, answer('next'));
  const last = h.segment('15', '10-00-00', thread, `_${turn}`); appendFileSync(last, answer('last'));
  h.segment('16', '10-00-00', foreign);
  await source.flush(); expect(events).toEqual([]); expect(source.checkpoint().path).toBe(old);
  appendFileSync(old, '\n'); await source.flush(); await source.flush(); await source.flush();
  expect(events.map(e => e.data.text)).toEqual(['old', 'next', 'last']);
  expect(source.checkpoint().path).toBe(last);
  await source.flush(); expect(events).toHaveLength(3);
});

it('restores a durable cursor in an older verified segment, drains offline bytes, then resumes from 0 in later segments', async () => {
  const h = fixture(), old = h.segment('14', '10-00-00'), original = h.source(); await original.flush();
  appendFileSync(old, answer('already observed')); await original.flush(); const cursor = original.checkpoint(); original.stop();
  appendFileSync(old, line({ type: 'event_msg', payload: { type: 'user_message', turn_id: turn, message: 'offline input' } }) + answer('offline old'));
  const next = h.segment('15', '10-00-00', thread, `_${turn}`); appendFileSync(next, answer('offline new'));
  const restored = h.source(), events: NormalizedDriverEvent[] = []; restored.onEvent(e => events.push(e));
  restored.restore(cursor); await restored.flush(); await restored.flush();
  expect(restored.checkpoint().path).toBe(next);
  expect(events.map(e => e.data.text)).toEqual(['offline old', 'offline new']);
  const other = h.segment('16', '10-00-00', foreign);
  expect(() => h.source().restore({ path: other, offset: 0 })).toThrow(/restore rejected/);
});

it('accepts an exact input first written into a new segment and reconstructs that turn after restart', async () => {
  const h = fixture(), old = h.segment('14', '10-00-00'), source = h.source(); await source.flush();
  const cursor = source.checkpoint();
  const receipt = source.waitForInput('question', new AbortController().signal);
  const next = h.segment('15', '10-00-00', thread, `_${turn}`);
  appendFileSync(old, answer('drained before switching'));
  appendFileSync(next, line({ type: 'event_msg', payload: { type: 'user_message', turn_id: turn, message: 'question' } })
    + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, error: { message: 'failure after resume' } } }));
  await source.flush(); await receipt;
  expect(source.takeInputError()).toMatchObject({ data: { message: 'failure after resume' } }); source.stop();
  const restored = h.source(); restored.restore(cursor); await restored.flush(); await restored.flush();
  expect(restored.hasTurnTerminal()).toBe(true);
  expect(restored.takeInputError()).toMatchObject({ data: { message: 'failure after resume' } });
});

it('locates a canonical-only session marker without history, rejecting foreign thread/turn and injected users', async () => {
  const h = fixture(); rmSync(join(h.opts.cwd, 'cli', 'history.jsonl'));
  const path = h.segment('15', '10-00-00', thread, `_${turn}`);
  const mutation = (completionThread: string, completionTurn: string) => line({ type: 'history_mutation', payload: { operation: 'append', turn_id: turn,
    display_completions: [{ thread_id: completionThread, turn_id: completionTurn, item: { type: 'UserMessage', content: [{ type: 'Text', text: 'ses_segment-fixture' }] } }] } });
  appendFileSync(path, mutation(foreign, turn) + mutation(thread, 'foreign-turn') + line({ type: 'history_mutation', payload: { operation: 'append', turn_id: turn,
    items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'ses_segment-fixture' }] }] } }));
  expect(resolveTraexRolloutPath(h.opts.cwd, h.opts.env, h.opts.sessionId)).toBeUndefined();
  appendFileSync(path, mutation(thread, turn));
  expect(resolveTraexRolloutPath(h.opts.cwd, h.opts.env, h.opts.sessionId)).toBe(path);
  const source = h.source(), events: NormalizedDriverEvent[] = []; source.onEvent(e => events.push(e)); await source.flush();
  const receipt = source.waitForInput('question', new AbortController().signal);
  appendFileSync(path, line({ type: 'history_mutation', timestamp: new Date().toISOString(), payload: { operation: 'append', turn_id: 'new-turn',
    display_completions: [{ thread_id: thread, turn_id: 'new-turn', item: { type: 'UserMessage', content: [{ type: 'text', text: 'question' }] } }] } })
    + line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new-turn', last_agent_message: 'canonical-only answer' } }));
  await source.flush(); await receipt;
  expect(events.filter(e => e.type === 'text').map(e => e.data.text)).toEqual(['canonical-only answer']);
  expect(source.hasTurnTerminal()).toBe(true);
});


it('requires session metadata before accepting a canonical marker from a named rollout', () => {
  const h = fixture(); rmSync(join(h.opts.cwd, 'cli', 'history.jsonl'));
  const path = h.segment('15', '10-00-00');
  writeFileSync(path, line({ type: 'history_mutation', payload: { operation: 'append', turn_id: turn,
    display_completions: [{ thread_id: thread, turn_id: turn, item: { type: 'UserMessage', content: [{ type: 'text', text: 'ses_segment-fixture' }] } }] } }));
  expect(resolveTraexRolloutPath(h.opts.cwd, h.opts.env, h.opts.sessionId)).toBeUndefined();
});

it('discovers a segment created after the last scan in the same flush and at the default 300ms poll', async () => {
  vi.useFakeTimers();
  try {
    const h = fixture(); h.segment('14', '10-00-00'); const source = h.source();
    const events: NormalizedDriverEvent[] = []; source.onEvent(event => events.push(event)); source.start(); await source.flush();
    const next = h.segment('14', '11-00-00', thread, `_${turn}`); appendFileSync(next, answer('flush'));
    await source.flush(); expect(events.map(event => event.data.text)).toEqual(['flush']);
    const last = h.segment('15', '10-00-00', thread, `_${turn}`); appendFileSync(last, answer('poll'));
    await vi.advanceTimersByTimeAsync(299); expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(events.map(event => event.data.text)).toEqual(['flush', 'poll']);
    expect(source.checkpoint().path).toBe(last);
  } finally { vi.useRealTimers(); }
});
