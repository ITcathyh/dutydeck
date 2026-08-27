/**
 * Tests for transcript event extraction (Claude jsonl + Codex rollout).
 *
 * Uses real temp directories and files; the tailer polls at a fast interval
 * so the suite stays quick while exercising the actual fs-watching path.
 *
 * Run: pnpm vitest run packages/pty-driver/src/transcript/transcript.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedDriverEvent } from '@dockmux/shared';
import { ClaudeTranscriptTailer, resolveClaudeTranscriptPath } from './claude.js';
import { CodexTranscriptTailer, resolveCodexRolloutPath } from './codex.js';
import { createTranscriptTailer } from './index.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dockmux-transcript-${prefix}-`));
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  tempRoots = [];
});

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});

function collect(source: { onEvent(cb: (e: NormalizedDriverEvent) => void): void }): NormalizedDriverEvent[] {
  const events: NormalizedDriverEvent[] = [];
  source.onEvent(e => events.push(e));
  return events;
}

describe('ClaudeTranscriptTailer (explicit path)', () => {
  it('maps assistant thinking/text/tool_use and user tool_result in order', async () => {
    const dir = makeTempDir('claude-explicit');
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '');

    const tailer = new ClaudeTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendFileSync(file, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think about this' },
          { type: 'text', text: 'Here is the answer.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a/b.ts' } },
        ],
      },
    }) + '\n');
    await sleep(150);

    expect(events.map(e => e.type)).toEqual(['thinking', 'text', 'tool_call']);
    expect(events[0]!.data).toEqual({ text: 'let me think about this' });
    expect(events[1]!.data).toEqual({ text: 'Here is the answer.' });
    expect(events[2]!.data).toEqual({
      id: 'toolu_1',
      name: 'Read',
      input: { file_path: '/a/b.ts' },
      status: 'running',
    });

    appendFileSync(file, JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents here' },
        ],
      },
    }) + '\n');
    await sleep(150);

    expect(events.map(e => e.type)).toEqual(['thinking', 'text', 'tool_call', 'tool_result']);
    expect(events[3]!.data).toEqual({
      id: 'toolu_1',
      status: 'completed',
      output: 'file contents here',
    });

    tailer.stop();
  });

  it('maps failed tool_result and array-form tool_result content', async () => {
    const dir = makeTempDir('claude-failed');
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '');

    const tailer = new ClaudeTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendFileSync(file, JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_err',
          is_error: true,
          content: [{ type: 'text', text: 'ENOENT: no such file' }],
        }],
      },
    }) + '\n');
    await sleep(150);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('tool_result');
    expect(events[0]!.data.status).toBe('failed');
    expect(events[0]!.data.output).toBe('ENOENT: no such file');

    tailer.stop();
  });

  it('buffers a half-written line and emits only once the newline arrives', async () => {
    const dir = makeTempDir('claude-halfline');
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '');

    const tailer = new ClaudeTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendFileSync(file, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"HALFW');
    await sleep(150);
    expect(events).toHaveLength(0);

    appendFileSync(file, 'RITE"}]}}\n');
    await sleep(150);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('text');
    expect(events[0]!.data.text).toBe('HALFWRITE');

    tailer.stop();
  });

  it('skips malformed lines and sidechain / API-error entries', async () => {
    const dir = makeTempDir('claude-skip');
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '');

    const tailer = new ClaudeTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendFileSync(file, 'this is not json\n');
    appendFileSync(file, JSON.stringify({
      type: 'assistant',
      isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] },
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      error: 'rate_limit',
      message: { role: 'assistant', content: [{ type: 'text', text: 'rate limited' }] },
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'real answer' }] },
    }) + '\n');
    await sleep(150);

    expect(events).toHaveLength(1);
    expect(events[0]!.data.text).toBe('real answer');

    tailer.stop();
  });

  it('polls until a not-yet-created transcript file appears', async () => {
    const dir = makeTempDir('claude-lazy');
    const file = join(dir, 'future-session.jsonl');

    const tailer = new ClaudeTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    await sleep(100);
    writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first line after creation' }] },
    }) + '\n');
    await sleep(150);

    expect(events).toHaveLength(1);
    expect(events[0]!.data.text).toBe('first line after creation');

    tailer.stop();
  });

  it('emits nothing after stop()', async () => {
    const dir = makeTempDir('claude-stop');
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '');

    const tailer = new ClaudeTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();
    tailer.stop();

    appendFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'after stop' }] },
    }) + '\n');
    await sleep(150);
    expect(events).toHaveLength(0);
  });
});

describe('ClaudeTranscriptTailer (directory resolution + switching)', () => {
  it('resolves the newest jsonl by cwd project key and switches to a newer file', async () => {
    const configDir = makeTempDir('claude-config');
    const cwd = makeTempDir('claude-cwd');
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const projectKey = cwd.replace(/[^A-Za-z0-9-]/g, '-');
    const projectDir = join(configDir, 'projects', projectKey);
    mkdirSync(projectDir, { recursive: true });

    const oldFile = join(projectDir, 'old-session.jsonl');
    const midFile = join(projectDir, 'mid-session.jsonl');
    writeFileSync(oldFile, JSON.stringify({ type: 'summary' }) + '\n');
    writeFileSync(midFile, JSON.stringify({ type: 'summary' }) + '\n');
    const now = Date.now() / 1000;
    utimesSync(oldFile, now - 10_000, now - 10_000);
    utimesSync(midFile, now - 5_000, now - 5_000);

    expect(resolveClaudeTranscriptPath(cwd)).toBe(midFile);

    const tailer = new ClaudeTranscriptTailer({ cwd, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();
    await sleep(100);

    // Appending to the resolved file produces events.
    appendFileSync(midFile, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from mid session' }] },
    }) + '\n');
    await sleep(150);
    expect(events.map(e => e.data.text)).toContain('from mid session');

    // A newer jsonl appears (session switch): the tailer follows it.
    const newFile = join(projectDir, 'new-session.jsonl');
    writeFileSync(newFile, JSON.stringify({ type: 'summary' }) + '\n');
    utimesSync(newFile, now + 10_000, now + 10_000);
    await sleep(100);

    appendFileSync(newFile, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from new session' }] },
    }) + '\n');
    await sleep(150);
    expect(events.map(e => e.data.text)).toContain('from new session');

    // Appending to the old file after the switch does not emit.
    appendFileSync(midFile, JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'stale mid append' }] },
    }) + '\n');
    await sleep(150);
    expect(events.map(e => e.data.text)).not.toContain('stale mid append');

    tailer.stop();
  });
});

describe('CodexTranscriptTailer (explicit path)', () => {
  it('maps reasoning, tool calls/outputs, and task_complete final text', async () => {
    const dir = makeTempDir('codex-explicit');
    const file = join(dir, 'rollout-2026-08-27T10-00-00-01234567-89ab-cdef-0123-456789abcdef.jsonl');
    writeFileSync(file, '');

    const tailer = new CodexTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendFileSync(file, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'planning the fix' }],
      },
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'shell',
        arguments: '{"command":["ls"]}',
      },
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"output":"file1\\nfile2","metadata":{}}',
      },
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn_1', last_agent_message: 'All done.' },
    }) + '\n');
    await sleep(200);

    expect(events.map(e => e.type)).toEqual(['thinking', 'tool_call', 'tool_result', 'text']);
    expect(events[0]!.data).toEqual({ text: 'planning the fix' });
    expect(events[1]!.data).toEqual({
      id: 'call_1',
      name: 'shell',
      input: { command: ['ls'] },
      status: 'running',
    });
    expect(events[2]!.data).toEqual({
      id: 'call_1',
      status: 'completed',
      output: 'file1\nfile2',
    });
    expect(events[3]!.data).toEqual({ text: 'All done.' });

    tailer.stop();
  });

  it('maps custom_tool_call / local_shell_call / web_search_call and old-schema final phase', async () => {
    const dir = makeTempDir('codex-misc');
    const file = join(dir, 'rollout-x.jsonl');
    writeFileSync(file, '');

    const tailer = new CodexTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendFileSync(file, JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c_1', name: 'view_image', input: '{"image":42}' },
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      type: 'response_item',
      payload: { type: 'local_shell_call', call_id: 'c_2', action: { command: ['echo', 'hi'] } },
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      type: 'response_item',
      payload: { type: 'web_search_call', call_id: 'c_3', action: { query: 'dockmux' } },
    }) + '\n');
    appendFileSync(file, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final',
        content: [{ type: 'output_text', text: 'final answer text' }],
      },
    }) + '\n');
    await sleep(200);

    expect(events.map(e => e.type)).toEqual(['tool_call', 'tool_call', 'tool_call', 'text']);
    expect(events[0]!.data.name).toBe('view_image');
    expect(events[1]!.data.name).toBe('shell');
    expect(events[2]!.data.name).toBe('web_search');
    expect(events[3]!.data.text).toBe('final answer text');

    tailer.stop();
  });

  it('buffers a half-written rollout line', async () => {
    const dir = makeTempDir('codex-halfline');
    const file = join(dir, 'rollout-y.jsonl');
    writeFileSync(file, '');

    const tailer = new CodexTranscriptTailer({ cwd: dir, transcriptPath: file, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();

    appendFileSync(file, '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t","last_agent_message":"PART');
    await sleep(150);
    expect(events).toHaveLength(0);

    appendFileSync(file, 'IAL"}}\n');
    await sleep(150);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.text).toBe('PARTIAL');

    tailer.stop();
  });
});

describe('resolveCodexRolloutPath', () => {
  it('picks the newest rollout under CODEX_HOME/sessions/YYYY/MM/DD', () => {
    const home = makeTempDir('codex-home');
    process.env.CODEX_HOME = home;
    const dayDir = join(home, 'sessions', '2026', '08', '27');
    mkdirSync(dayDir, { recursive: true });

    const older = join(dayDir, 'rollout-2026-08-27T09-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    const newer = join(dayDir, 'rollout-2026-08-27T10-30-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    writeFileSync(older, '{}\n');
    writeFileSync(newer, '{}\n');
    const now = Date.now() / 1000;
    utimesSync(older, now - 10_000, now - 10_000);
    utimesSync(newer, now - 1_000, now - 1_000);

    expect(resolveCodexRolloutPath('/any/cwd')).toBe(newer);
  });

  it('returns undefined when no sessions dir exists', () => {
    const home = makeTempDir('codex-empty');
    process.env.CODEX_HOME = home;
    expect(resolveCodexRolloutPath('/any/cwd')).toBeUndefined();
  });
});

describe('createTranscriptTailer', () => {
  it('returns a Claude tailer for claude-code, Codex for codex, undefined otherwise', () => {
    const cwd = makeTempDir('factory');
    expect(createTranscriptTailer('claude-code', { cwd })).toBeInstanceOf(ClaudeTranscriptTailer);
    expect(createTranscriptTailer('codex', { cwd })).toBeInstanceOf(CodexTranscriptTailer);
    expect(createTranscriptTailer('gemini', { cwd })).toBeUndefined();
    expect(createTranscriptTailer('aiden', { cwd })).toBeUndefined();
  });
});
