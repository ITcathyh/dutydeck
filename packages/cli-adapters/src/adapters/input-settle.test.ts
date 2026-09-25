import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeClaudeFamilyInput } from './claude-family.js';
import { createCodexAdapter } from './codex.js';
import { INPUT_ECHO_SETTLE_MS, INPUT_ECHO_TIMEOUT_MS, INPUT_QUIET_MS, INPUT_QUIET_TIMEOUT_MS } from './input-settle.js';
import type { PtyLike } from '../types.js';

/** A pane whose output clock advances whenever it echoes what we typed. */
class EchoingBackend implements PtyLike {
  outputAt: number;
  echo = true;
  echoDelayMs = 0;
  readonly processKey: object;
  readonly writes: Array<{ at: number; data: string }> = [];

  constructor(outputAt: number, processKey: object = {}) {
    this.outputAt = outputAt;
    this.processKey = processKey;
  }
  lastOutputAt(): number { return this.outputAt; }
  write(data: string): void { this.record(data); }
  sendText(text: string): void { this.record(text); }
  sendSpecialKeys(...keys: string[]): void { this.record(keys.join('+')); }
  pasteText(text: string): void { this.record(text); }
  private record(data: string): void {
    this.writes.push({ at: Date.now(), data });
    if (!this.echo) return;
    if (this.echoDelayMs === 0) this.outputAt = Date.now();
    else setTimeout(() => { this.outputAt = Date.now(); }, this.echoDelayMs);
  }
}

async function run(write: Promise<void>, ms = 30_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await write;
}

/** Claude's first write to a process adds a 200ms settle and an 80ms chunk throttle. */
async function warmedClaudeProcess(): Promise<object> {
  const processKey = {};
  await run(writeClaudeFamilyInput(new EchoingBackend(Date.now() - 60_000, processKey), 'warm up'));
  return processKey;
}

describe('user input waits for a quiet screen and its echo', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('Claude writes at once when the screen has already been quiet for the whole quiet window', async () => {
    const processKey = await warmedClaudeProcess();
    const start = Date.now();
    const backend = new EchoingBackend(start - INPUT_QUIET_MS, processKey);
    await run(writeClaudeFamilyInput(backend, 'hello'));
    expect(backend.writes.map(write => write.data)).toEqual(['hello', 'Enter']);
    expect(backend.writes[0]!.at).toBe(start);
    // Exactly the timing without these waits: one 30ms chunk tick, then the fixed 500ms before Enter.
    expect(backend.writes[1]!.at - start).toBe(30 + 500);
  });

  it('Claude waits only for the rest of the quiet window, extended by new output', async () => {
    const processKey = await warmedClaudeProcess();
    let start = Date.now();
    const partlyQuiet = new EchoingBackend(start - 200, processKey);
    await run(writeClaudeFamilyInput(partlyQuiet, 'hello'));
    expect(partlyQuiet.writes[0]!.at - start).toBe(INPUT_QUIET_MS - 200);

    start = Date.now();
    const busy = new EchoingBackend(start, processKey);
    setTimeout(() => { busy.outputAt = Date.now(); }, 300);
    await run(writeClaudeFamilyInput(busy, 'hello'));
    expect(busy.writes[0]!.at - start).toBe(300 + INPUT_QUIET_MS);
  });

  it('Claude submits once the echo has been stable for 300ms', async () => {
    const processKey = await warmedClaudeProcess();
    const start = Date.now();
    const backend = new EchoingBackend(start - INPUT_QUIET_MS, processKey);
    backend.echoDelayMs = 400;
    await run(writeClaudeFamilyInput(backend, 'hello'));
    expect(backend.writes.at(-1)).toEqual({ at: start + 400 + INPUT_ECHO_SETTLE_MS, data: 'Enter' });
  });

  it('a screen that never settles delays input by the bounded timeouts only', async () => {
    const start = Date.now();
    const backend = new EchoingBackend(start);
    const redraw = setInterval(() => { backend.outputAt = Date.now(); }, 100);
    try {
      await run(writeClaudeFamilyInput(backend, 'hello'));
    } finally {
      clearInterval(redraw);
    }
    const typed = backend.writes[0]!;
    const enter = backend.writes.at(-1)!;
    // 200ms first-write settle, then the quiet timeout.
    expect(typed.at - start).toBe(200 + INPUT_QUIET_TIMEOUT_MS);
    expect(enter.data).toBe('Enter');
    // 80ms first-write chunk tick, the fixed 500ms, then the echo timeout.
    expect(enter.at - typed.at).toBe(80 + 500 + INPUT_ECHO_TIMEOUT_MS);
  });

  it('submits after the echo timeout when nothing is echoed', async () => {
    const start = Date.now();
    const backend = new EchoingBackend(start - 60_000);
    backend.echo = false;
    await run(writeClaudeFamilyInput(backend, 'hello'));
    expect(backend.writes[0]!.at - start).toBe(200);
    expect(backend.writes.at(-1)!.at - backend.writes[0]!.at).toBe(80 + 500 + INPUT_ECHO_TIMEOUT_MS);
  });

  it('Claude warms up once per CLI process, not once per submission wrapper', async () => {
    const processKey = {};
    let start = Date.now();
    const first = new EchoingBackend(start - 60_000, processKey);
    await run(writeClaudeFamilyInput(first, 'first'));
    expect(first.writes[0]!.at - start).toBe(200);
    expect(first.writes.at(-1)!.at - start).toBe(200 + 80 + 500);

    start = Date.now();
    const second = new EchoingBackend(start - 60_000, processKey);
    await run(writeClaudeFamilyInput(second, 'second'));
    expect(second.writes[0]!.at - start).toBe(0);
    expect(second.writes.at(-1)!.at - start).toBe(30 + 500);

    start = Date.now();
    const respawned = new EchoingBackend(start - 60_000);
    await run(writeClaudeFamilyInput(respawned, 'third'));
    expect(respawned.writes[0]!.at - start).toBe(200);
  });

  it('Codex pastes at once on a quiet screen and presses Enter once the echo settles', async () => {
    let start = Date.now();
    const quiet = new EchoingBackend(start - INPUT_QUIET_MS);
    await run(Promise.resolve(createCodexAdapter().writeInput(quiet, 'line 1\nline 2')));
    expect(quiet.writes).toEqual([
      { at: start, data: 'line 1\nline 2' },
      { at: start + INPUT_ECHO_SETTLE_MS, data: 'Enter' },
    ]);

    start = Date.now();
    const busy = new EchoingBackend(start);
    await run(Promise.resolve(createCodexAdapter().writeInput(busy, 'hi')));
    expect(busy.writes[0]!.at - start).toBe(INPUT_QUIET_MS);
  });

  it('keeps the previous timing on a backend without an output clock', async () => {
    const writes: string[] = [];
    const claude = writeClaudeFamilyInput({ write: data => { writes.push(data); } }, 'hello');
    await vi.advanceTimersByTimeAsync(700);
    await claude;
    expect(writes.at(-1)).toBe('\r');
    const codex = Promise.resolve(createCodexAdapter().writeInput({ write: data => { writes.push(data); } }, 'hi'));
    await vi.advanceTimersByTimeAsync(200);
    await codex;
    expect(writes.at(-1)).toBe('\r');
  });
});
