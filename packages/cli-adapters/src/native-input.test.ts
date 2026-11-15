import { expect, it, vi } from 'vitest';
import { DriverRecoveryError, PromptNotWrittenError } from '@dutydeck/shared';
import { createCliAdapter } from './factory.js';
import { isInputReady } from './adapters/screen-ready-helper.js';
import { readFileSync } from 'node:fs';

const traexReady = (JSON.parse(readFileSync(new URL('./fixtures/traex-startup/native.json', import.meta.url), 'utf8')) as { loaded: string }).loaded;

// Captured footer/composer shape from Codex 0.159.3's native resume smoke;
// workspace, conversation title and response are harmless fixture values.
const ready = 'fixture answer\nWorked for 10s • 17:51\n› Ask Codex to do anything\nGPT-6-Astra low · /tmp/fixture/workspace · 执行隔离验收命令 ⚠ 2 warnings · f2 to view';
it('accepts the initialized Codex resume footer with a conversation title while retaining menu/busy guards', () => {
  expect(isInputReady(ready, 'Codex')).toBe(true);
  expect(isInputReady(ready.replace('› Ask Codex to do anything', '› 1. Approve and continue'), 'Codex')).toBe(false);
  expect(isInputReady('Review hooks\n' + ready, 'Codex')).toBe(false);
  expect(isInputReady('Working (esc to interrupt)\n' + ready, 'Codex')).toBe(false);
  expect(isInputReady(ready.replace('执行隔离验收命令', 'Working'), 'Codex')).toBe(false);
  expect(isInputReady(ready.replace('执行隔离验收命令', 'Select permissions'), 'Codex')).toBe(false);
  expect(isInputReady(ready.replace('/tmp/fixture/workspace', 'uninitialized'), 'Codex')).toBe(false);
});

it.each(['codex', 'traex'])('%s pastes one normalized message and preserves Unicode before submitting Enter', async id => {
  vi.useFakeTimers();
  try {
    const adapter = createCliAdapter(id), writes: string[] = [], keys: string[] = [];
    const pending = adapter.writeInput({ readScreen: () => id === 'traex' ? traexReady : ready,
      write(data) { writes.push(data); }, pasteText(text) { writes.push(text); }, sendSpecialKeys(...value) { keys.push(...value); } }, '中文👩‍💻\u200c\u200b\r\nsecond\rthird');
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(writes).toEqual(['中文👩‍💻\u200c\u200b\nsecond\nthird']); expect(keys).toEqual(['Enter']);
    expect(adapter.capabilities.nativeInputReceipt).toBe(true);
  } finally { vi.useRealTimers(); }
});

const traexQuestion = 'Question 1/1 (1 unanswered)\nWhich database should the new service use?\n❯ 1. PostgreSQL (Recommended)\n  2. SQLite';

it('TraeX reports not-written when the native question page arrives before paste', async () => {
  vi.useFakeTimers();
  try {
    let reads = 0;
    const writes: string[] = [], keys: string[] = [];
    const pending = createCliAdapter('traex').writeInput({
      readScreen: () => ++reads === 1 ? traexReady : traexQuestion,
      write(data) { writes.push(data); }, pasteText(text) { writes.push(text); }, sendSpecialKeys(...value) { keys.push(...value); },
    }, 'do not paste');
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBeInstanceOf(PromptNotWrittenError);
    expect(reads).toBe(2);
    expect(writes).toEqual([]);
    expect(keys).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('TraeX leaves a pasted prompt unconfirmed instead of answering a native question', async () => {
  vi.useFakeTimers();
  try {
    let screen = traexReady, reads = 0;
    const writes: string[] = [], keys: string[] = [];
    const pending = createCliAdapter('traex').writeInput({
      readScreen: () => { reads++; return screen; },
      write(data) { writes.push(data); },
      pasteText(text) { writes.push(text); screen = traexQuestion; },
      sendSpecialKeys(...value) { keys.push(...value); },
    }, 'paste but do not answer');
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await outcome;
    expect(error).toBeInstanceOf(DriverRecoveryError);
    expect(error).toMatchObject({
      name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED',
    });
    expect(reads).toBe(3);
    expect(writes).toEqual(['paste but do not answer']);
    expect(keys).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it('TraeX waits through a resume redraw before the authoritative paste check', async () => {
  vi.useFakeTimers();
  try {
    const screens = [traexReady, 'Resuming session…', traexReady];
    let reads = 0;
    const writes: string[] = [], keys: string[] = [];
    const pending = createCliAdapter('traex').writeInput({
      readScreen: () => screens[Math.min(reads++, screens.length - 1)]!,
      write(data) { writes.push(data); }, pasteText(text) { writes.push(text); }, sendSpecialKeys(...value) { keys.push(...value); },
    }, 'resume once');
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBeUndefined();
    expect(writes).toEqual(['resume once']);
    expect(keys).toEqual(['Enter']);
    expect(reads).toBeGreaterThanOrEqual(4);
  } finally { vi.useRealTimers(); }
});

it.each([
  'Question 1/1 (1 unanswered)\nWhich database should we use?\nNo numeric options are visible',
  'Assistant reply: Question 1/1 (1 unanswered) is an example, not a dialog\n1. This is prose, not a native option',
  `${traexQuestion}\nWorked for 1s\n❯ ordinary composer content\nContext 92% left`,
])('TraeX still submits when the screen has no complete native question structure', async screenAfterPaste => {
  vi.useFakeTimers();
  try {
    let screen = traexReady;
    const keys: string[] = [];
    const pending = createCliAdapter('traex').writeInput({
      readScreen: () => screen,
      write() {}, pasteText() { screen = screenAfterPaste; }, sendSpecialKeys(...value) { keys.push(...value); },
    }, 'ordinary input');
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(keys).toEqual(['Enter']);
  } finally { vi.useRealTimers(); }
});
