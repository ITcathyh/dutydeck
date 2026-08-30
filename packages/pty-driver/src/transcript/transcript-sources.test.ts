/**
 * Tests for the transcript sources added in M2: TRAE rollout + Grok ACP.
 *
 * Same style as transcript.test.ts — real temp files, real polling tailers.
 *
 * Run: npx vitest run packages/pty-driver/src/transcript/transcript-sources.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dockmux/shared';
import { GrokTranscriptTailer, mapGrokEntry, resolveGrokUpdatesPath } from './grok.js';
import { TraexTranscriptTailer, mapTraexEntry, resolveTraexRolloutPath } from './traex.js';
import { createTranscriptTailer, TRANSCRIPT_ADAPTER_IDS } from './index.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll an assertion until it passes or times out. Assertion SEMANTICS are
 * unchanged — the same expect() calls run, retried to absorb the tailer's
 * poll interval plus load-induced jitter under the full concurrent suite.
 * Used for every "the event eventually arrives" check; a bare sleep+assert
 * is what makes these flaky.
 */
async function waitForAssert<T>(fn: () => T, timeoutMs = 10_000, intervalMs = 25): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (Date.now() - start > timeoutMs) throw lastError;
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }
}

let tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dockmux-tsrc-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  tempRoots = [];
});

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

function collect(source: { onEvent(cb: (e: NormalizedDriverEvent) => void): void }): NormalizedDriverEvent[] {
  const events: NormalizedDriverEvent[] = [];
  source.onEvent(e => events.push(e));
  return events;
}

function appendJson(path: string, entry: unknown): void {
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

// ─── TRAE ──────────────────────────────────────────────────────────────────

describe('mapTraexEntry', () => {
  it('reuses the Codex mapping for the shared rollout dialect', () => {
    expect(mapTraexEntry({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'planning' }] },
    })).toEqual([{ type: 'thinking', data: { text: 'planning' } }]);

    expect(mapTraexEntry({
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' },
    })).toEqual([{
      type: 'tool_call',
      data: { id: 'c1', name: 'shell', input: { command: ['ls'] }, status: 'running' },
    }]);

    expect(mapTraexEntry({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Done.' },
    })).toEqual([{ type: 'text', data: { text: 'Done.' } }]);
  });

  it('maps the TRAE-only agent_message dialects (final_answer phase and phase-less)', () => {
    expect(mapTraexEntry({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'the final reply' },
    })).toEqual([{ type: 'text', data: { text: 'the final reply' } }]);

    // A later TRAE build dropped `phase` entirely.
    expect(mapTraexEntry({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'phase-less final' },
    })).toEqual([{ type: 'text', data: { text: 'phase-less final' } }]);
  });

  it('drops a non-final agent_message phase (mid-turn narration)', () => {
    expect(mapTraexEntry({
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'commentary', message: 'let me check…' },
    })).toBeUndefined();
  });

  it('maps the item_completed AgentMessage dialect and ignores UserMessage items', () => {
    expect(mapTraexEntry({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'AgentMessage', text: 'item final' } },
    })).toEqual([{ type: 'text', data: { text: 'item final' } }]);

    expect(mapTraexEntry({
      type: 'event_msg',
      payload: { type: 'item_completed', item: { type: 'UserMessage', text: 'the prompt' } },
    })).toBeUndefined();
  });
});

describe('TraexTranscriptTailer', () => {
  it('tails a rollout file and emits thinking / tool / text in order', async () => {
    const dir = makeTempDir('traex-explicit');
    const file = join(dir, 'rollout-2026-08-30T01-00-00-01a02e6e-8e60-74a0-9293-3eeb2f2ba5b5.jsonl');
    writeFileSync(file, '');

    const tailer = new TraexTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendJson(file, {
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking first' }] },
    });
    appendJson(file, {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":["ls"]}' },
    });
    appendJson(file, {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: '{"output":"a\\nb","metadata":{}}' },
    });
    appendJson(file, {
      type: 'event_msg',
      payload: { type: 'agent_message', phase: 'final_answer', message: 'all done' },
    });

    await waitForAssert(() => {
      expect(events.map(e => e.type)).toEqual(['thinking', 'tool_call', 'tool_result', 'text']);
    });
    expect(events[2]!.data).toEqual({ id: 'c1', status: 'completed', output: 'a\nb' });
    expect(events[3]!.data).toEqual({ text: 'all done' });

    tailer.stop();
  });
});

describe('resolveTraexRolloutPath', () => {
  it('picks the newest rollout under TRAE_HOME/cli/sessions/YYYY/MM/DD', () => {
    const home = makeTempDir('trae-home');
    setEnv('TRAE_HOME', home);
    const dayDir = join(home, 'cli', 'sessions', '2026', '08', '30');
    mkdirSync(dayDir, { recursive: true });
    const older = join(dayDir, 'rollout-2026-08-30T09-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    const newer = join(dayDir, 'rollout-2026-08-30T10-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    writeFileSync(older, '{}\n');
    writeFileSync(newer, '{}\n');
    const now = Date.now() / 1000;
    utimesSync(older, now - 10_000, now - 10_000);
    utimesSync(newer, now - 1_000, now - 1_000);

    expect(resolveTraexRolloutPath()).toBe(newer);
  });

  it('returns undefined when no sessions tree exists', () => {
    setEnv('TRAE_HOME', makeTempDir('trae-empty'));
    expect(resolveTraexRolloutPath()).toBeUndefined();
  });
});

// ─── Grok ──────────────────────────────────────────────────────────────────

/** Wrap an ACP update the way Grok writes updates.jsonl lines. */
function grokLine(update: unknown, sessionId = '019dd80d-d922-7a11-8339-0208d8c5b4ec'): unknown {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } };
}

describe('mapGrokEntry', () => {
  it('maps agent_thought_chunk to thinking and agent_message_chunk to text', () => {
    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'let me think' },
    }))).toEqual([{ type: 'thinking', data: { text: 'let me think' } }]);

    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'here is the answer' },
    }))).toEqual([{ type: 'text', data: { text: 'here is the answer' } }]);
  });

  it('maps tool_call using toolCallId / title / rawInput', () => {
    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-e2',
      title: 'run_terminal_command',
      rawInput: { command: 'ls -la' },
    }))).toEqual([{
      type: 'tool_call',
      data: { id: 'call-e2', name: 'run_terminal_command', input: { command: 'ls -la' }, status: 'running' },
    }]);
  });

  it('maps in_progress to running and a terminal tool_call_update to tool_result', () => {
    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', status: 'in_progress',
    }))![0]!.data.status).toBe('running');

    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
    }))).toEqual([{ type: 'tool_result', data: { id: 't1', status: 'completed', output: 'file body' } }]);

    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed',
    }))).toEqual([{ type: 'tool_result', data: { id: 't2', status: 'failed', output: '' } }]);
  });

  it('falls back to rawOutput when a result carries no content blocks', () => {
    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't3',
      status: 'completed',
      rawOutput: { exitCode: 0, stdout: 'ok' },
    }))![0]!.data.output).toBe('{"exitCode":0,"stdout":"ok"}');
  });

  it('accepts the top-level update form and the namespaced method', () => {
    expect(mapGrokEntry({
      method: '_x.ai/session/update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'top level' } },
    })).toEqual([{ type: 'text', data: { text: 'top level' } }]);
  });

  it('skips user_message_chunk and turn_completed (driver owns turn boundaries)', () => {
    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'our own prompt' },
    }))).toBeUndefined();
    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'turn_completed', stop_reason: 'end_turn',
    }))).toBeUndefined();
  });

  it('skips a tool event with no toolCallId and a chunk with a non-text content block', () => {
    expect(mapGrokEntry(grokLine({ sessionUpdate: 'tool_call', title: 'nameless' }))).toBeUndefined();
    expect(mapGrokEntry(grokLine({
      sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'base64…' },
    }))).toBeUndefined();
  });
});

describe('GrokTranscriptTailer', () => {
  it('tails updates.jsonl and emits a full thinking → tool → result → text turn', async () => {
    const dir = makeTempDir('grok-explicit');
    const file = join(dir, 'updates.jsonl');
    writeFileSync(file, '');

    const tailer = new GrokTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendJson(file, grokLine({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run the linter' } }));
    appendJson(file, grokLine({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'checking config' } }));
    appendJson(file, grokLine({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'run_terminal_command', rawInput: { command: 'lint' } }));
    appendJson(file, grokLine({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '0 problems' } }] }));
    appendJson(file, grokLine({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Lint is clean.' } }));
    appendJson(file, grokLine({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }));

    await waitForAssert(() => {
      expect(events.map(e => e.type)).toEqual(['thinking', 'tool_call', 'tool_result', 'text']);
    });
    expect(events[1]!.data.id).toBe('call-1');
    expect(events[2]!.data.output).toBe('0 problems');
    expect(events[3]!.data.text).toBe('Lint is clean.');

    tailer.stop();
  });

  it('buffers a half-written line until the newline arrives', async () => {
    const dir = makeTempDir('grok-halfline');
    const file = join(dir, 'updates.jsonl');
    writeFileSync(file, '');

    const tailer = new GrokTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendFileSync(file, '{"params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"PAR');
    // Several poll intervals with no newline: nothing may be emitted yet.
    await sleep(150);
    expect(events).toHaveLength(0);

    appendFileSync(file, 'TIAL"}}}}\n');
    await waitForAssert(() => {
      expect(events).toHaveLength(1);
      expect(events[0]!.data.text).toBe('PARTIAL');
    });

    tailer.stop();
  });
});

describe('resolveGrokUpdatesPath', () => {
  it('picks the newest session directory inside the cwd bucket', () => {
    const home = makeTempDir('grok-home');
    const cwd = makeTempDir('grok-cwd');
    setEnv('GROK_HOME', home);
    const bucket = join(home, 'sessions', encodeURIComponent(cwd));
    const older = join(bucket, 'aaaaaaaa-0000-0000-0000-000000000001');
    const newer = join(bucket, 'bbbbbbbb-0000-0000-0000-000000000002');
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(older, 'updates.jsonl'), '');
    writeFileSync(join(newer, 'updates.jsonl'), '');
    const now = Date.now() / 1000;
    utimesSync(join(older, 'updates.jsonl'), now - 10_000, now - 10_000);
    utimesSync(join(newer, 'updates.jsonl'), now - 100, now - 100);

    expect(resolveGrokUpdatesPath(cwd)).toBe(join(newer, 'updates.jsonl'));
  });

  it('returns undefined when the cwd has no bucket yet', () => {
    setEnv('GROK_HOME', makeTempDir('grok-empty'));
    expect(resolveGrokUpdatesPath(makeTempDir('grok-cwd'))).toBeUndefined();
  });
});

// ─── factory ───────────────────────────────────────────────────────────────

describe('createTranscriptTailer (extended sources)', () => {
  it('returns the right tailer for traex and grok, still undefined for unported CLIs', () => {
    const cwd = makeTempDir('factory');
    expect(createTranscriptTailer('traex', { cwd })).toBeInstanceOf(TraexTranscriptTailer);
    expect(createTranscriptTailer('grok', { cwd })).toBeInstanceOf(GrokTranscriptTailer);
    expect(createTranscriptTailer('gemini', { cwd })).toBeUndefined();
    expect(createTranscriptTailer('kimi', { cwd })).toBeUndefined();
    expect(createTranscriptTailer('cursor', { cwd })).toBeUndefined();
  });

  it('every advertised adapter id actually produces a tailer', () => {
    const cwd = makeTempDir('factory-ids');
    for (const id of TRANSCRIPT_ADAPTER_IDS) {
      expect(createTranscriptTailer(id, { cwd }), id).toBeDefined();
    }
  });
});
