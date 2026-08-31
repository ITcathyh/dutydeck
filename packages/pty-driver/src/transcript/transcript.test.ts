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

/**
 * Regression: two dockmux sessions sharing one cwd must never see each other's
 * transcript.
 *
 * The project dir is keyed by cwd ALONE, so N sessions in one repo write N
 * jsonl files into ONE directory. Resolving by mtime there returns whoever
 * wrote last — a sibling, most of the time. Observed end-to-end before the
 * fix, in both directions:
 *   - three sessions racing at spawn: all three saw ZERO assistant text and
 *     were failed as "Agent 未返回最终输出", while all three on-disk
 *     transcripts were perfectly correct;
 *   - the same three staggered by 3s: all three reported `completed` and two
 *     of them displayed the third's answer verbatim. That one is the more
 *     dangerous shape — it lies successfully.
 */
describe('ClaudeTranscriptTailer (同 cwd 多会话隔离)', () => {
  /** A first-prompt entry carrying the session marker, as the CLI records it. */
  const markerEntry = (sessionId: string) => JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: `<dockmux_session_id>${sessionId}</dockmux_session_id>\nhello` }] },
  }) + '\n';
  const assistantEntry = (text: string) => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';

  function setupTwoSessions() {
    const configDir = makeTempDir('claude-isolation-config');
    const cwd = makeTempDir('claude-isolation-cwd');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const projectDir = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    // Pinned ids: dockmux passes `--session-id <uuid>` and Claude names the
    // file after it (cli-adapters/adapters/claude-family.ts buildArgs).
    const mine = '11111111-1111-4111-8111-111111111111';
    const sibling = '22222222-2222-4222-8222-222222222222';
    const mineFile = join(projectDir, `${mine}.jsonl`);
    const siblingFile = join(projectDir, `${sibling}.jsonl`);
    writeFileSync(mineFile, markerEntry(`ses_${mine}`));
    writeFileSync(siblingFile, markerEntry(`ses_${sibling}`));
    // The sibling wrote LAST — exactly the state that made the mtime pick
    // hand our tailer the sibling's file.
    const now = Date.now() / 1000;
    utimesSync(mineFile, now - 10, now - 10);
    utimesSync(siblingFile, now, now);
    return { cwd, mine, sibling, mineFile, siblingFile };
  }

  it('按 session id 定位到自己的 jsonl，而不是目录里最新的那个', () => {
    const { cwd, mine, mineFile, siblingFile } = setupTwoSessions();
    expect(resolveClaudeTranscriptPath(cwd, process.env, `ses_${mine}`)).toBe(mineFile);
    // 不传 session id 时才退回「取最新」——这条固定住那个退化路径的语义，
    // 免得有人以为无 id 也安全。
    expect(resolveClaudeTranscriptPath(cwd)).toBe(siblingFile);
  });

  it('CLI 拒绝了钉住的 id 时，靠首轮 marker 找回自己的 transcript', () => {
    const { cwd, mine } = setupTwoSessions();
    // Claude 撞到同名会话会自己铸一个 id：文件名不再是我们钉的那个，
    // 但首轮 prompt 里的 marker 仍然是我们的。
    const configDir = process.env.CLAUDE_CONFIG_DIR!;
    const projectDir = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    rmSync(join(projectDir, `${mine}.jsonl`));
    const cliMinted = join(projectDir, '33333333-3333-4333-8333-333333333333.jsonl');
    writeFileSync(cliMinted, markerEntry(`ses_${mine}`));
    utimesSync(cliMinted, Date.now() / 1000 - 100, Date.now() / 1000 - 100); // 故意做成最旧
    expect(resolveClaudeTranscriptPath(cwd, process.env, `ses_${mine}`)).toBe(cliMinted);
  });

  it('两条会话各自只收到自己的 assistant text', async () => {
    const { cwd, mine, sibling, mineFile, siblingFile } = setupTwoSessions();
    const mineTailer = new ClaudeTranscriptTailer({ cwd, sessionId: `ses_${mine}`, pollIntervalMs: 25 });
    const siblingTailer = new ClaudeTranscriptTailer({ cwd, sessionId: `ses_${sibling}`, pollIntervalMs: 25 });
    const mineEvents = collect(mineTailer);
    const siblingEvents = collect(siblingTailer);
    mineTailer.start();
    siblingTailer.start();
    await sleep(100);

    appendFileSync(mineFile, assistantEntry('MINE answer'));
    appendFileSync(siblingFile, assistantEntry('SIBLING answer'));
    await sleep(200);

    const mineTexts = mineEvents.map(e => e.data.text);
    const siblingTexts = siblingEvents.map(e => e.data.text);
    expect(mineTexts).toContain('MINE answer');
    expect(mineTexts).not.toContain('SIBLING answer');
    expect(siblingTexts).toContain('SIBLING answer');
    expect(siblingTexts).not.toContain('MINE answer');

    mineTailer.stop();
    siblingTailer.stop();
  });

  it('会话自己的 transcript 还没落盘时，绝不临时借用兄弟会话的', async () => {
    // 这是 burst 场景：两条会话几乎同时 spawn，兄弟的文件先出现。
    // 旧实现会立刻挂上兄弟的文件，于是本会话的时间线里出现别人的回答。
    const configDir = makeTempDir('claude-pending-config');
    const cwd = makeTempDir('claude-pending-cwd');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const projectDir = join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    const sibling = '22222222-2222-4222-8222-222222222222';
    const siblingFile = join(projectDir, `${sibling}.jsonl`);
    writeFileSync(siblingFile, markerEntry(`ses_${sibling}`));

    const mine = '11111111-1111-4111-8111-111111111111';
    const tailer = new ClaudeTranscriptTailer({ cwd, sessionId: `ses_${mine}`, pollIntervalMs: 25 });
    const events = collect(tailer);
    tailer.start();
    await sleep(100);
    appendFileSync(siblingFile, assistantEntry('SIBLING answer'));
    await sleep(150);
    expect(events.map(e => e.data.text)).not.toContain('SIBLING answer');

    // 自己的文件出现后必须接上——resolve 会重试，不是一次失败就永久放弃。
    const mineFile = join(projectDir, `${mine}.jsonl`);
    writeFileSync(mineFile, markerEntry(`ses_${mine}`));
    await sleep(100);
    appendFileSync(mineFile, assistantEntry('MINE answer'));
    await sleep(200);
    expect(events.map(e => e.data.text)).toContain('MINE answer');

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

  /**
   * Codex's rollout root is GLOBAL — the path encodes no cwd — so every
   * concurrent session competes to be "newest", including sessions in other
   * repos. Same hazard as the Claude project dir, one degree worse.
   *
   * Note what these two cover and what they do not: the id→file mapping and
   * the refusal to guess. Recovering the CLI's own id from history.jsonl is
   * session-id/codex.ts's job and is tested there; end-to-end behaviour
   * against a real `codex` binary is NOT verified here (only the Claude path
   * has E2E evidence).
   */
  it('给了 session id 就按 id 定位 rollout，不受「谁最后写」影响', () => {
    const home = makeTempDir('codex-scoped');
    process.env.CODEX_HOME = home;
    const dayDir = join(home, 'sessions', '2026', '08', '27');
    mkdirSync(dayDir, { recursive: true });
    const mineId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const mine = join(dayDir, `rollout-2026-08-27T09-00-00-${mineId}.jsonl`);
    const sibling = join(dayDir, 'rollout-2026-08-27T10-30-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl');
    // history.jsonl 是 session-id 反查的第一来源：一行一次提交，带 marker。
    writeFileSync(join(home, 'history.jsonl'),
      JSON.stringify({ session_id: mineId, ts: 1, text: '<dockmux_session_id>ses_deadbeef-1111-4111-8111-111111111111</dockmux_session_id> hi' }) + '\n');
    writeFileSync(mine, JSON.stringify({ type: 'session_meta', payload: { session_id: mineId, cwd: '/any/cwd' } }) + '\n');
    writeFileSync(sibling, '{}\n');
    const now = Date.now() / 1000;
    utimesSync(mine, now - 10_000, now - 10_000);
    utimesSync(sibling, now, now);   // 兄弟最后写 —— 旧实现会挑中它

    expect(resolveCodexRolloutPath('/any/cwd', process.env, 'ses_deadbeef-1111-4111-8111-111111111111')).toBe(mine);
    expect(resolveCodexRolloutPath('/any/cwd')).toBe(sibling);   // 无 id 才退回取最新
  });

  it('认不出这条会话时返回 undefined，而不是退回去猜一个最新的', () => {
    const home = makeTempDir('codex-unknown');
    process.env.CODEX_HOME = home;
    const dayDir = join(home, 'sessions', '2026', '08', '27');
    mkdirSync(dayDir, { recursive: true });
    const sibling = join(dayDir, 'rollout-2026-08-27T10-30-00-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl');
    writeFileSync(sibling, '{}\n');
    // 没有 history.jsonl、rollout 里也没有我们的 marker → 无从确认身份。
    // 此时「没有 transcript」是安全的（退回屏幕识别兜底），
    // 「挑一个最新的」则会把别人的话写进这条会话的时间线。
    expect(resolveCodexRolloutPath('/any/cwd', process.env, 'ses_deadbeef-1111-4111-8111-111111111111')).toBeUndefined();
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
