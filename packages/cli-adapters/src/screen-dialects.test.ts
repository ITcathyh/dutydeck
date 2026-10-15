import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTraexAdapter } from './adapters/traex.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createCursorAdapter } from './adapters/cursor.js';
import { isInputReady, isTrustPrompt } from './adapters/screen-ready-helper.js';

const traex = createTraexAdapter();
const footer = (status: string, rule = '────────────', prompt = '❯ Ask TraeCode CLI') => ['TraeX', status, rule, prompt, 'Context 100% left'].join('\n');
const busy = (screen: string) => traex.isBusyScreen?.(screen) ?? false;

it.each([...'⋄◇◆✦◈❖✧'])('uses the full viewport for TraeX %s activity, hook and capacity queue states', glyph => {
  for (const label of ['Working…', "Shh, it's thinking…", 'Running PreToolUse hook', 'Running PostToolUse hook', 'Running UserPromptSubmit hook', 'Queued for capacity', 'Queued for next turn']) {
    const screen = footer(`${glyph} ${label} (1m 5s • ↓ 9 tokens • esc to interrupt)`);
    expect(busy(screen), label).toBe(true);
    expect(isInputReady(screen, 'TraeX', traex.busyPattern), label).toBe(false);
  }
});

it('recognizes the recorded TraeX footer viewports and keeps raw geometry rules out of idle-to-busy', () => {
  const tape = JSON.parse(readFileSync(new URL('./fixtures/traex-startup/0.209.1-footers.json', import.meta.url), 'utf8')) as { frames: { kind: string; screen: string }[] };
  for (const frame of tape.frames) expect(busy(frame.screen), frame.screen).toBe(frame.kind === 'busy');
  expect(traex.idleToBusyPattern?.test('❖ Working… (1s • esc to interrupt)')).toBe(false);
});

it('ignores quoted prose, full footer examples, draft continuations and tool output with the same words', () => {
  const ready = footer('  Worked for 3s • 11:08 PM');
  for (const body of [
    '◆ Press Escape to cancel (esc to interrupt).',
    '◆ ❖ Working… (1s • esc to interrupt)',
    '  ❖ Working… (1s • esc to interrupt)\n  ─────\n  ❯ quoted composer',
    '◆ Tool output:\n  Running PreToolUse hook (1s • esc to interrupt)',
  ]) {
    const screen = `${body}\n${ready}`;
    expect(busy(screen)).toBe(false); expect(isInputReady(screen, 'TraeX', traex.busyPattern)).toBe(true);
  }
  const draft = ready.replace('❯ Ask TraeCode CLI', `❯ draft first line\n${'  draft continuation\n'.repeat(40)}  ❖ Working… (1s • esc to interrupt)\n  ─────\n  ❯ quoted composer`);
  expect(busy(draft)).toBe(false); expect(isInputReady(draft, 'TraeX', traex.busyPattern)).toBe(false);
  const quotedDraft = ready.replace('❯ Ask TraeCode CLI', '❯ Explain "❖ Working… (1s • esc to interrupt)"');
  expect(busy(quotedDraft)).toBe(false);
});

it('preserves ANSI, blank/stale rule rows and queue detail rows without unbounded regex work', () => {
  expect(busy(footer('\x1b[32m❖\x1b[0m Working… (1s • esc to interupt)', ''))).toBe(true);
  expect(busy(footer('❖ Working… (1s • esc to interrupt)', 'stale repaint'))).toBe(true);
  expect(busy(footer('◆ Queued for capacity (1s • esc to interrupt)\n  └ Too many requests right now. You are in the queue'))).toBe(true);
  const started = performance.now();
  expect(busy(footer(`◆ Working… (1s • ${'1s '.repeat(50_000)}`))).toBe(false);
  expect(performance.now() - started).toBeLessThan(200);
});

it('holds both TraeX preparation and writeInput during geometry busy, then unlocks on the same reader', async () => {
  vi.useFakeTimers();
  try {
    let screen = footer('❖ Working… (1s • esc to interrupt)'); const writes: string[] = [];
    const backend = { readScreen: () => screen, write(data: string) { writes.push(data); } };
    const prepared = traex.prepareInput!(backend, { sessionId: 'fixture' });
    const pending = traex.writeInput(backend, 'next\nline');
    await vi.advanceTimersByTimeAsync(1000); expect(writes).toEqual([]);
    screen = footer('  Worked for 1s');
    await vi.advanceTimersByTimeAsync(500); await prepared; await pending;
    expect(writes).toEqual(['\x1b[200~next\nline\x1b[201~', '\r']);
  } finally { vi.useRealTimers(); }
});

// Official openai/codex rust-v0.162.1 effort_ignition.rs:105-108 maps
// Ultra to » and Max to ›; fixture layout follows the initialized composer.
it('accepts Codex Ultra » on both startup and adapter readiness, with full footer guards', async () => {
  const adapter = createCodexAdapter();
  const ready = 'Codex\n» Ask Codex to do anything\nContext 100% left';
  expect(adapter.readyPattern?.test('» ')).toBe(true);
  expect(isInputReady(ready, 'Codex')).toBe(true);
  await adapter.prepareInput!({ readScreen: () => ready, write() {} }, { sessionId: 'fixture' });
  for (const invalid of ['» 1. Update now', '» unsent draft', '» 1. Trust and continue']) {
    expect(isInputReady(ready.replace('» Ask Codex to do anything', invalid), 'Codex')).toBe(false);
  }
  expect(adapter.readyPattern?.test('» 1. Update now')).toBe(false);
  expect(isTrustPrompt('Trust this folder?\n» 1. Trust and continue', 'Codex')).toBe(true);
  expect(isInputReady('Review hooks\n' + ready, 'Codex')).toBe(false);
  expect(isInputReady('Working (esc to interrupt)\n' + ready, 'Codex')).toBe(false);
});

it.each(['raw', 'keyed'] as const)('Cursor %s submits once and preserves multi-line soft newlines and the first-write settle', async mode => {
  vi.useFakeTimers();
  try {
    const writes: string[] = [], keys: string[] = [];
    const backend = { write(data: string) { writes.push(data); }, ...(mode === 'keyed' ? {
      sendText(data: string) { writes.push(data); }, sendSpecialKeys(...data: string[]) { keys.push(...data); },
    } : {}) };
    const adapter = createCursorAdapter(); const pending = adapter.writeInput(backend, 'first\nsecond');
    await vi.advanceTimersByTimeAsync(199); expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1200); await pending;
    expect(mode === 'keyed' ? keys : writes.filter(w => w === '\r')).toEqual(mode === 'keyed' ? ['C-j', 'Enter'] : ['\r', '\r']);
    expect(writes).toEqual(mode === 'keyed' ? ['first', 'second'] : ['first', '\\', '\r', 'second', '\r']);
    writes.length = 0; keys.length = 0;
    const next = adapter.writeInput(backend, 'single'); await vi.advanceTimersByTimeAsync(31);
    expect(writes).toEqual(['single']); await vi.advanceTimersByTimeAsync(1000); await next;
    expect(mode === 'keyed' ? keys : writes).toEqual(mode === 'keyed' ? ['Enter'] : ['single', '\r']);
  } finally { vi.useRealTimers(); }
});
