import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dockmux/cli-adapters';
import type { NormalizedDriverEvent } from '@dockmux/shared';
import type { SessionBackend } from '@dockmux/session-backends';
import { PtyCliDriver } from './driver.js';

// The 2026-09-08 incident kept this footer visible while streaming a long
// answer. The prompt was redrawn many times; a two-second pause was not EOF.
const busyFooter = '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents';
const idleFooter = '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const repaint = (text: string) => `\x1b[2J\x1b[H${text.replaceAll('\n', '\r\n')}`;
const finalText = '完整结论：已核实全部材料。\n\n正文第一部分。\n\n正文最后一部分。';

describe('PTY result completion with a real terminal snapshot and transcript', () => {
  let directory: string;
  let driver: PtyCliDriver;
  let output: (data: string) => void;
  let events: NormalizedDriverEvent[];
  let transcript: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), 'dockmux-completion-'));
    const project = join(directory, 'projects', realpathSync(directory).replace(/[^A-Za-z0-9-]/g, '-'));
    mkdirSync(project, { recursive: true });
    transcript = join(project, 'completion-fixture.jsonl');
    writeFileSync(transcript, '');
    events = [];
    const backend: SessionBackend = {
      kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, onExit() {},
      onData(callback) { output = callback; },
      interrupt() { output(repaint(`Interrupted · What should Claude do instead?\n❯\n${idleFooter}`)); }
    };
    driver = new PtyCliDriver({
      agent: { id: 'claude-code', name: 'Claude', command: 'unused', args: [], protocol: 'pty-cli', cwd: directory,
        env: { CLAUDE_CONFIG_DIR: directory }, permissionMode: 'full-trust', timeout: 60,
        capabilities: { pause: false, resume: true }, builtin: false },
      adapter: { ...createCliAdapter('claude-code'), writeInput() {} },
      backend, sessionId: 'ses_completion-fixture', onEvent: event => events.push(event), onExit() {}
    });
    await driver.start();
  });

  afterEach(async () => {
    await driver?.stop();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  const answer = (file: string, text = finalText) => appendFileSync(file,
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n');

  it('keeps a streaming turn open across silent pauses and partial redraws, then delivers the whole answer', async () => {
    let settled = false;
    const pending = driver.send('总结消息').then(() => { settled = true; });
    await Promise.resolve();
    answer(transcript, '等第 2 段返回。');
    output(repaint(`❯ 总结消息\n正文仍在输出\n\n\n\n${busyFooter}`));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(false);
    expect(events.some(event => event.type === 'completed')).toBe(false);
    // Busy evidence stays in the rendered footer; it is not in these bytes.
    output('\x1b[2;1H后续正文');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(false);
    answer(transcript);
    output(repaint(`${finalText}\n✻ Cooked for 16m 55s · done 7:56 PM\n❯\n${idleFooter}`));
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
    const finalIndex = events.findIndex(event => event.type === 'text' && event.data.text === finalText);
    expect(finalIndex).toBeGreaterThan(0);
    expect(finalIndex).toBeLessThan(events.findIndex(event => event.type === 'completed'));
  });

  it('flushes a final record written between the last poll and the completion timer', async () => {
    const pending = driver.send('总结消息');
    await Promise.resolve();
    output(repaint(`✻ Cooked for 16m 55s\n❯\n${idleFooter}`));
    await vi.advanceTimersByTimeAsync(499);
    answer(transcript);
    expect(events.some(event => event.type === 'text')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(events.filter(event => ['text', 'completed'].includes(event.type)).map(event => event.type)).toEqual(['text', 'completed']);
    await vi.advanceTimersByTimeAsync(300);
    expect(events.filter(event => event.type === 'text')).toHaveLength(1);
  });

  it('can still finish after interruption clears the busy footer without a duration marker', async () => {
    const pending = driver.send('总结消息');
    await Promise.resolve();
    output(repaint(`❯ 总结消息\n\n${busyFooter}`));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(events.some(event => event.type === 'completed')).toBe(false);
    // A user can also press Ctrl-C directly in the terminal.
    output(repaint(`Interrupted · What should Claude do instead?\n❯\n${idleFooter}`));
    await vi.advanceTimersByTimeAsync(4_000);
    await pending;
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  });

  it('rechecks a vetoed idle when only the footer is cleared', async () => {
    const pending = driver.send('总结消息');
    await Promise.resolve();
    output(repaint(`❯ 总结消息\n\n${busyFooter}`));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(events.some(event => event.type === 'completed')).toBe(false);
    answer(transcript);
    output(`\x1b[3;1H\x1b[2K${idleFooter}`);
    await vi.advanceTimersByTimeAsync(4_000);
    await pending;
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
  });

  it.each([120, 40])('distinguishes a quoted busy hint from the actual footer at %i columns', async cols => {
    driver.createTerminalStream().resize(cols, 30);
    const pending = driver.send('解释快捷键');
    await Promise.resolve();
    output(repaint(`❯ 解释快捷键\n\n${busyFooter}`));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(events.some(event => event.type === 'completed')).toBe(false);
    const text = '快捷键提示 esc to interrupt 表示可以中断当前执行。';
    answer(transcript, text);
    output(repaint(`${text}\n✻ Cooked for 4s\n❯\n${idleFooter}`));
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
    expect(events.find(event => event.type === 'text')?.data.text).toBe(text);
  });
});
