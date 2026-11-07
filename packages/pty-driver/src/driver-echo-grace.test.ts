import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionBackend } from '@dutydeck/session-backends';
import type { NormalizedDriverEvent } from '@dutydeck/shared';
import { PtyCliDriver } from './driver.js';

// A CLI without native receipts or transcripts completes from the screen alone.
// Its prompt echo is not output: a pause after the echo, before the CLI starts
// working, falls inside the startup grace period and must not end the turn.
let driver: PtyCliDriver;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => { await driver.stop(); vi.useRealTimers(); });

async function fixture() {
  let output!: (data: string) => void;
  const events: NormalizedDriverEvent[] = [];
  const backend: SessionBackend = { kind: 'pty', spawn() {}, write() {}, resize() {}, kill() {}, interrupt() {}, onExit() {}, onData(cb) { output = cb; } };
  driver = new PtyCliDriver({
    agent: { id: 'fixture', name: 'Fixture', command: 'unused', args: [], env: {}, protocol: 'pty-cli',
      permissionMode: 'full-trust', timeout: 600, builtin: false, capabilities: { pause: false, resume: false } },
    // The CLI moves the submitted prompt into its history and redraws an empty composer.
    adapter: { id: 'fixture', capabilities: {}, buildArgs: () => [], readyPattern: /❯/, writeInput(_backend, prompt) {
      output(`\r\x1b[K${prompt.split('\n').map((line, index) => (index ? '  ' : '❯ ') + line).join('\r\n')}\r\n\r\n❯ `);
    } },
    backend, sessionId: 'ses_echo-grace', onEvent: event => events.push(event), onExit() {},
  });
  await driver.start();
  output('Fixture CLI v1\r\n\r\n❯ ');
  await vi.advanceTimersByTimeAsync(250);
  return { output: (data: string) => output(data), completed: () => events.filter(event => event.type === 'completed').length };
}

it('keeps the turn open through a pause after the bare prompt echo and completes on the answer', async () => {
  const f = await fixture();
  const pending = driver.send('summarize the repository layout');
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.completed()).toBe(0);
  f.output('\r\x1b[KThe repository has three packages.\r\n\r\n❯ ');
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.completed()).toBe(1);
  await pending;

  // A wrapped CJK echo on a screen that still shows the previous answer is still only an echo.
  const next = driver.send('请总结这个仓库的目录结构，' + 'and list every package with its purpose '.repeat(5));
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.completed()).toBe(1);
  f.output('\r\x1b[K共有三个包。\r\n\r\n❯ ');
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.completed()).toBe(2);
  await next;
});

it('counts output that the CLI redraws away before the renderer parses it', async () => {
  const f = await fixture();
  const pending = driver.send('summarize the repository layout');
  await vi.advanceTimersByTimeAsync(250);
  // Both chunks are queued before xterm parses either; only the first one shows the answer.
  f.output('\r\x1b[KThe repository has three packages.');
  f.output('\x1b[2J\x1b[H❯ ');
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.completed()).toBe(1);
  await pending;
});

it('still completes a quiet echo-only screen once the grace period ends', async () => {
  const f = await fixture();
  const pending = driver.send('summarize the repository layout');
  await vi.advanceTimersByTimeAsync(14_000);
  expect(f.completed()).toBe(0);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(f.completed()).toBe(1);
  await pending;
});
