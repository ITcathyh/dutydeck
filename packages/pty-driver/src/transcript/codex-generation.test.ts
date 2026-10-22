import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { CodexTranscriptTailer, findRolloutBySessionId } from './codex.js';

const sid = '11111111-1111-4111-8111-111111111111', gen = '22222222-2222-4222-8222-222222222222', foreign = '99999999-9999-4999-8999-999999999999';
const line = (entry: unknown) => JSON.stringify(entry) + '\n';
const record = (type: string, fields: Record<string, unknown> = {}, turn = 'current') => line({ type: 'event_msg', payload: { type, turn_id: turn, ...fields } });
const input = (turn = 'current') => record('task_started', {}, turn) + line({ type: 'event_msg', payload: { type: 'user_message', message: 'question' } });
const final = (turn = 'current') => record('task_complete', { last_agent_message: '相同回复' }, turn);
const dirs: string[] = [], sources: CodexTranscriptTailer[] = [];
afterEach(() => { vi.useRealTimers(); for (const source of sources) source.stop(); sources.length = 0; for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
async function flush(source: CodexTranscriptTailer) { vi.advanceTimersByTime(1_001); await source.flush(); }
function fixture() {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'dd-codex-generation-')); dirs.push(dir);
  const root = join(dir, 'sessions'); mkdirSync(root);
  writeFileSync(join(dir, 'history.jsonl'), line({ session_id: sid, ts: Date.now() / 1000, text: '<dutydeck_session_id>ses_generation</dutydeck_session_id>' }));
  const segment = (day: string, suffix = '', metaId = sid) => {
    const path = join(root, '2026', '10', day, `rollout-2026-10-${day}T10-00-00-${sid}${suffix}.jsonl`);
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, line({ type: 'session_meta', payload: { id: metaId, cwd: dir } })); return path;
  };
  const source = () => { const source = new CodexTranscriptTailer({ cwd: dir, sessionId: 'ses_generation', env: { CODEX_HOME: dir } }); sources.push(source); return source; };
  const index = (path: string) => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT)');
    db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?)').run(sid, path); db.close();
  };
  return { dir, root, segment, source, index };
}
it('selects verified same-session generations by filename creation order rather than touched canonical mtime', () => {
  const h = fixture(), old = h.segment('20'), next = h.segment('21', `_${gen}`);
  utimesSync(old, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  expect(findRolloutBySessionId(h.root, sid)).toBe(next);
});
it.each(['foreign', 'partial', 'oversized'] as const)('refuses a %s generation header', kind => {
  const h = fixture(), old = h.segment('20'), next = h.segment('21', `_${gen}`, kind === 'foreign' ? foreign : sid);
  if (kind === 'partial') writeFileSync(next, line({ type: 'session_meta', payload: { id: sid } }).trimEnd());
  if (kind === 'oversized') writeFileSync(next, line({ type: 'session_meta', payload: { id: sid, instructions: 'x'.repeat(1024 * 1024) } }));
  expect(findRolloutBySessionId(h.root, sid)).toBe(old);
});
it('uses a verified native index, including a canonical filename, and rejects paths outside the session root', () => {
  const h = fixture(), old = h.segment('20'); h.segment('21', `_${gen}`); h.index(old);
  expect(findRolloutBySessionId(h.root, sid)).toBe(old);
  const outside = join(h.dir, `rollout-outside-${sid}.jsonl`); writeFileSync(outside, line({ type: 'session_meta', payload: { id: sid } })); h.index(outside);
  expect(findRolloutBySessionId(h.root, sid)).not.toBe(outside);
});
it('preserves exact receipt and native turn while draining old records and replaying copied history once', async () => {
  const h = fixture(), old = h.segment('20'), source = h.source(), events: NormalizedDriverEvent[] = [];
  source.onEvent(event => events.push(event)); await flush(source);
  const receipt = source.waitForInput('question', new AbortController().signal);
  appendFileSync(old, input()); await flush(source); await receipt;
  const thinking = line({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'old thinking' }] } });
  appendFileSync(old, thinking);
  const next = h.segment('21', `_${gen}`); appendFileSync(next, input() + thinking + final());
  await flush(source);
  expect(source.checkpoint().path).toBe(next); expect(source.hasTurnTerminal()).toBe(true);
  expect(events.filter(event => event.type === 'thinking')).toHaveLength(1);
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['相同回复']);
  await flush(source); expect(events.filter(event => event.type === 'text')).toHaveLength(1);
});
it('does not treat copied timestamp-less prompts as a fresh exact receipt', async () => {
  const h = fixture(), old = h.segment('20'); appendFileSync(old, input('past') + final('past'));
  const source = h.source(); await flush(source); let confirmed = false;
  const controller = new AbortController(); const receipt = source.waitForInput('question', controller.signal).then(() => { confirmed = true; }); void receipt.catch(() => {});
  const next = h.segment('21', `_${gen}`); appendFileSync(next, input('past') + final('past')); await flush(source);
  expect(confirmed).toBe(false); expect(source.hasTurnTerminal()).toBe(false);
  appendFileSync(next, input('new')); await flush(source); await receipt; expect(confirmed).toBe(true);
  appendFileSync(next, final('new')); await flush(source); expect(source.hasTurnTerminal()).toBe(true);
});
it.each([false, true])('follows a complete generation after an old UTF-8 partial record (old deleted=%s)', async deleted => {
  const h = fixture(), old = h.segment('20'), source = h.source(), events: NormalizedDriverEvent[] = [];
  source.onEvent(event => events.push(event)); await flush(source);
  const receipt = source.waitForInput('question', new AbortController().signal); appendFileSync(old, input()); await flush(source); await receipt;
  const bytes = Buffer.from(final()), split = bytes.indexOf(Buffer.from('相')) + 1;
  appendFileSync(old, bytes.subarray(0, split)); await flush(source);
  const next = h.segment('21', `_${gen}`); appendFileSync(next, input() + final()); if (deleted) rmSync(old);
  await flush(source); expect(source.checkpoint().path).toBe(next);
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['相同回复']);
  expect(source.hasTurnTerminal()).toBe(true);
});
it('allows identical text in a different native turn after copying the previous completed final', async () => {
  const h = fixture(), old = h.segment('20'), source = h.source(), events: NormalizedDriverEvent[] = [];
  source.onEvent(event => events.push(event)); await flush(source);
  const first = source.waitForInput('question', new AbortController().signal); appendFileSync(old, input() + final()); await flush(source); await first;
  const next = h.segment('21', `_${gen}`); appendFileSync(next, input() + final()); await flush(source);
  const second = source.waitForInput('question', new AbortController().signal); appendFileSync(next, input('second') + final('second')); await flush(source); await second;
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['相同回复', '相同回复']);
});
it('rebuilds replay identities from a restored old cursor before following a generation', async () => {
  const h = fixture(), old = h.segment('20'), source = h.source(); await flush(source);
  appendFileSync(old, input() + final()); await flush(source); const cursor = source.checkpoint(); source.stop();
  const next = h.segment('21', `_${gen}`); appendFileSync(next, input() + final() + input('offline') + final('offline'));
  const restored = h.source(), events: NormalizedDriverEvent[] = []; restored.onEvent(event => events.push(event)); restored.restore(cursor);
  await flush(restored); await flush(restored);
  expect(restored.hasTurnTerminal()).toBe(true); expect(events.filter(event => event.type === 'text')).toHaveLength(1);
});

it('accepts the same timestamp-less prompt in a new native turn when the generation omits old history', async () => {
  const h = fixture(), old = h.segment('20'), source = h.source(); await flush(source);
  const first = source.waitForInput('question', new AbortController().signal); appendFileSync(old, input() + final()); await flush(source); await first;
  const second = source.waitForInput('question', new AbortController().signal);
  const next = h.segment('21', `_${gen}`); appendFileSync(next, input('second') + final('second'));
  await flush(source); await second; expect(source.hasTurnTerminal()).toBe(true);
});

it('retains identical timestamp-less legacy finals in different turns when the next generation omits old history', async () => {
  const h = fixture(), old = h.segment('20'), source = h.source(), events: NormalizedDriverEvent[] = [];
  source.onEvent(event => events.push(event)); await flush(source);
  const legacy = line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'same answer' }] } });
  const first = source.waitForInput('question', new AbortController().signal);
  appendFileSync(old, input() + legacy + record('task_complete')); await flush(source); await first;
  const second = source.waitForInput('question', new AbortController().signal);
  const next = h.segment('21', `_${gen}`); appendFileSync(next, input('second') + legacy + record('task_complete', {}, 'second'));
  await flush(source); await second;
  expect(source.hasTurnTerminal()).toBe(true);
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['same answer', 'same answer']);
});

it.each(['partial-foreign', 'oversized', 'malformed'] as const)('refuses a new canonical rollout with %s metadata after binding a native session', async kind => {
  const h = fixture(), old = h.segment('20'), source = h.source(), events: NormalizedDriverEvent[] = [];
  source.onEvent(event => events.push(event)); await flush(source);
  const receipt = source.waitForInput('question', new AbortController().signal); appendFileSync(old, input()); await flush(source); await receipt;
  const next = h.segment('21');
  const meta = line({ type: 'session_meta', payload: { id: foreign, cwd: h.dir } });
  if (kind === 'partial-foreign') writeFileSync(next, meta.slice(0, 20));
  else if (kind === 'oversized') writeFileSync(next, line({ type: 'session_meta', payload: { id: sid, instructions: 'x'.repeat(1024 * 1024) } }));
  else writeFileSync(next, '{bad metadata}\n');
  await flush(source); expect(source.checkpoint().path).toBe(old);
  if (kind === 'partial-foreign') appendFileSync(next, meta.slice(20));
  appendFileSync(next, line({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'FOREIGN SESSION ANSWER' }] } }));
  // Even inside the positive resolver cache window, the unverified file was
  // never made active, so completing its foreign metadata cannot leak output.
  await source.flush(); expect(events.filter(event => event.type === 'text')).toEqual([]);
  expect(source.checkpoint().path).toBe(old);
});

it('skips a newer unfinished canonical file and still follows the next verified generation', async () => {
  const h = fixture(), old = h.segment('20'), source = h.source(), events: NormalizedDriverEvent[] = [];
  source.onEvent(event => events.push(event)); await flush(source);
  const receipt = source.waitForInput('question', new AbortController().signal);
  appendFileSync(old, input()); await flush(source); await receipt;
  const valid = h.segment('21', `_${gen}`); appendFileSync(valid, input() + final());
  const unfinished = h.segment('22'); writeFileSync(unfinished, line({ type: 'session_meta', payload: { id: sid } }).slice(0, 20));
  await flush(source); await flush(source);
  expect(source.checkpoint().path).toBe(valid); expect(source.hasTurnTerminal()).toBe(true);
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['相同回复']);
});
