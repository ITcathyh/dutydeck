import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
vi.mock('../session-id/fs-scan.js', async original => {
  const actual = await original<typeof import('../session-id/fs-scan.js')>();
  return { ...actual, readHead: vi.fn(actual.readHead) };
});
import { readHead } from '../session-id/fs-scan.js';
import { TraexTranscriptTailer, resolveTraexRolloutPath } from './traex.js';
import { traexSegments } from './traex-segments.js';

// Captured 0.207.1-alpha.12 rollout: identities/prompt sanitized, unrelated
// records omitted. Rebuild catalog size without storing 335 KB of private data.
const records = readFileSync(new URL('./fixtures/traex-0.207.1-terminal.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const dirs: string[] = [], sources: TraexTranscriptTailer[] = [];
afterEach(() => { sources.splice(0).forEach(source => source.stop()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

it.each([false, true])('finds and drains a real TraeX terminal behind oversized metadata (history available first=%s)', async historyFirst => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-traex-metadata-')); dirs.push(directory);
  const day = join(directory, 'cli', 'sessions', '2026', '10', '17'); mkdirSync(day, { recursive: true });
  const thread = records[0].payload.id;
  const path = join(day, `rollout-2026-10-17T18-29-10-${thread}.jsonl`);
  const history = join(directory, 'cli', 'history.jsonl'); writeFileSync(history, '');
  const opts = { cwd: directory, env: { TRAE_HOME: directory }, sessionId: 'ses_traex-large-metadata' };
  const prompt = `<dutydeck_session_id>${opts.sessionId}</dutydeck_session_id>\nquestion`;
  const rows = structuredClone(records);
  for (const record of rows) {
    record.timestamp = new Date().toISOString();
    if (record.type === 'session_meta') {
      record.payload.cwd = directory;
      record.payload.model_catalog_snapshot.sanitized_padding = 'x'.repeat(335059);
    }
    if (record.payload.item?.type === 'UserMessage') record.payload.item.content[0].text = prompt;
  }
  writeFileSync(path, rows.slice(0, 2).map(row => JSON.stringify(row) + '\n').join(''));
  const source = new TraexTranscriptTailer(opts); sources.push(source);
  const events: NormalizedDriverEvent[] = []; source.onEvent(event => events.push(event)); await source.flush();
  const receipt = source.waitForInput(prompt, new AbortController().signal);
  appendFileSync(history, JSON.stringify({ session_id: thread, ts: Date.now() / 1000, text: prompt }) + '\n');
  if (historyFirst) await source.flush();
  appendFileSync(path, rows.slice(2).map(row => JSON.stringify(row) + '\n').join(''));
  await source.flush(); await receipt;
  expect(resolveTraexRolloutPath(opts.cwd, opts.env, opts.sessionId)).toBe(path);
  expect(source.checkpoint().path).toBe(path);
  expect(source.hasTurnTerminal()).toBe(true);
  expect(events.filter(event => event.type === 'text').map(event => event.data.text)).toEqual(['NONCLAUDE_CONTROL_OK']);
});

it.each(['foreign', 'missing', 'partial'])('rejects %s metadata even when the rollout filename matches', kind => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-traex-metadata-')); dirs.push(directory);
  const day = join(directory, 'cli', 'sessions', '2026', '10', '17'); mkdirSync(day, { recursive: true });
  const thread = records[0].payload.id;
  const path = join(day, `rollout-2026-10-17T18-29-10-${thread}.jsonl`);
  const sessionId = 'ses_traex-large-metadata';
  writeFileSync(join(directory, 'cli', 'history.jsonl'), JSON.stringify({ session_id: thread, ts: Date.now() / 1000, text: sessionId }) + '\n');
  const meta = { type: 'session_meta', payload: { id: thread, model_catalog_snapshot: { sanitized_padding: 'x'.repeat(335059) } } };
  writeFileSync(path, kind === 'foreign'
    ? JSON.stringify({ ...meta, payload: { ...meta.payload, id: 'foreign-thread' } }) + '\n' + JSON.stringify(meta) + '\n'
    : kind === 'partial' ? JSON.stringify(meta).slice(0, -1) : JSON.stringify(records.at(-1)) + '\n');
  expect(resolveTraexRolloutPath(directory, { TRAE_HOME: directory }, sessionId)).toBeUndefined();
});

it('bounds metadata probes and does not reread verified rollouts on every poll', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-traex-metadata-')); dirs.push(directory);
  const root = join(directory, 'sessions'), day = join(root, '2026', '10', '17'); mkdirSync(day, { recursive: true });
  const thread = records[0].payload.id;
  const meta = (padding: number) => JSON.stringify({ type: 'session_meta', payload: { id: thread, model_catalog_snapshot: { sanitized_padding: 'x'.repeat(padding) } } }) + '\n';
  const real = join(day, `rollout-2026-10-17T18-29-10-${thread}.jsonl`);
  const oversized = join(day, `rollout-2026-10-17T18-29-11-${thread}_2.jsonl`);
  writeFileSync(real, meta(335059));
  writeFileSync(oversized, meta(1024 * 1024));
  expect(traexSegments(root, thread)).toEqual([real]);
  const reads = vi.mocked(readHead).mock.calls.length;
  expect(traexSegments(root, thread)).toEqual([real]);
  expect(vi.mocked(readHead).mock.calls.slice(reads).map(call => call[0])).toEqual([oversized]);
  expect(vi.mocked(readHead).mock.calls.every(call => call[1] <= 1024 * 1024)).toBe(true);
});
