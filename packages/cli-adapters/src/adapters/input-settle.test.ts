import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverRecoveryError, PromptNotWrittenError } from '@dutydeck/shared';
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
  readScreen(): string { return '──────────\n❯\n──────────\n? for shortcuts'; }
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
    const readScreen = () => '──────────\n❯\n──────────\n? for shortcuts';
    const claude = writeClaudeFamilyInput({ write: data => { writes.push(data); }, readScreen }, 'hello');
    await vi.advanceTimersByTimeAsync(700);
    await claude;
    expect(writes.at(-1)).toBe('\r');
    const codex = Promise.resolve(createCodexAdapter().writeInput({ write: data => { writes.push(data); } }, 'hi'));
    await vi.advanceTimersByTimeAsync(200);
    await codex;
    expect(writes.at(-1)).toBe('\r');
  });
});

describe('Claude composer ownership around the first terminal write', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const box = (draft = '', status: string[] = []) => [
    '──────────', `❯${draft ? ` ${draft}` : ''}`, '──────────', ...status, '? for shortcuts',
  ].join('\n');
  const palette = `${box('/compact')}\n/compact  Free up context\n/clear  Clear conversation`;

  class ComposerBackend implements PtyLike {
    readonly processKey = {};
    readonly writes: string[] = [];
    outputAt = Date.now() - 60_000;
    onWrite?: (data: string) => void;
    constructor(public screen = box()) {}
    readScreen(): string { return this.screen; }
    lastOutputAt(): number { return this.outputAt; }
    write(data: string): void { this.record(data); }
    sendText(data: string): void { this.record(data); }
    sendSpecialKeys(...keys: string[]): void { for (const key of keys) this.record(key); }
    private record(data: string): void { this.writes.push(data); this.onWrite?.(data); }
  }

  async function finish(pending: Promise<void>): Promise<void> {
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
  }
  function bare(screen?: string): ComposerBackend {
    const backend = new ComposerBackend(screen);
    Object.assign(backend, { sendText: undefined, sendSpecialKeys: undefined });
    return backend;
  }

  it('accepts a minimal ordinary prompt before and after a bare-PTY paste', async () => {
    const initial = 'Claude Code v2.1.267 (mock)\r\n❯ \r\n';
    const backend = bare(initial);
    backend.onWrite = data => {
      if (data.includes('business body')) backend.screen = `${initial}....\r\n`;
    };
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await finish(pending);
    expect(backend.writes).toEqual(['\x1b[200~business body\x1b[201~', '\r']);
  });

  it('accepts its own single-line draft on a minimal resumed screen', async () => {
    const initial = 'Claude Code v2.1.267 (mock)\n✳ Worked for 1s\n❯';
    const backend = new ComposerBackend(initial);
    backend.onWrite = data => {
      if (data === 'business body') backend.screen = 'Claude Code v2.1.267 (mock)\n✳ Worked for 1s\n❯ business body';
    };
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await finish(pending);
    expect(backend.writes).toEqual(['business body', 'Enter']);
  });

  it.each([
    ['human draft', 'Claude Code v2.1.267 (mock)\n❯ unfinished human draft'],
    ['slash palette', 'Claude Code v2.1.267 (mock)\n❯\n/compact  Free up context'],
    ['historical prompt', 'Claude Code v2.1.267 (mock)\n❯ old request\nprevious answer'],
  ])('rejects a minimal %s without writing', async (_name, screen) => {
    const backend = new ComposerBackend(screen);
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(backend.writes).toEqual([]);
  });

  it('turns a foreign minimal draft after a bare-PTY paste into unknown without final Enter', async () => {
    const backend = bare('Claude Code v2.1.267 (mock)\n❯');
    backend.onWrite = data => {
      if (data.includes('business body')) backend.screen = 'Claude Code v2.1.267 (mock)\n❯ foreign draft';
    };
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes).toEqual(['\x1b[200~business body\x1b[201~']);
  });

  it.each([
    ['ordinary empty composer', box()],
    ['native placeholder', box('Try "refactor <filepath>"')],
    ['permission footer', box().replace('? for shortcuts', '⏵⏵ bypass permissions on (shift+tab to cycle)')],
    ['two statusLine rows', box('', ['Context 18%', 'custom status'])],
    ['transient paste expansion hint', box().replace('? for shortcuts', 'paste again to expand')],
  ])('accepts the %s immediately before writing', async (_name, screen) => {
    const backend = new ComposerBackend(screen);
    await finish(writeClaudeFamilyInput(backend, 'business body'));
    expect(backend.writes).toEqual(['business body', 'Enter']);
  });

  it.each([
    ['human draft', box('unfinished human draft')],
    ['compact draft', box('/compact')],
    ['slash palette', palette],
    ['historical prompt only', '❯ old request\nprevious answer'],
  ])('rejects %s after the quiet wait without writing business bytes', async (_name, screen) => {
    const backend = new ComposerBackend(screen);
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(backend.writes).toEqual([]);
  });

  it.each(['/compact', 'unfinished human draft'])('notices %s appearing during the quiet wait', async draft => {
    const backend = new ComposerBackend();
    backend.outputAt = Date.now();
    setTimeout(() => { backend.screen = box(draft); backend.outputAt = Date.now(); }, 400);
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(backend.writes).toEqual([]);
  });

  it('requires a current screen reader instead of submitting blindly', async () => {
    const writes: string[] = [];
    const pending = writeClaudeFamilyInput({ write(data) { writes.push(data); } }, 'business body');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(writes).toEqual([]);
  });

  it('turns a foreign composer after the first tmux chunk into unknown and stops later chunks', async () => {
    const backend = new ComposerBackend();
    backend.onWrite = data => {
      if (data === 'first') { backend.onWrite = undefined; backend.screen = palette; }
    };
    const pending = writeClaudeFamilyInput(backend, 'first\nsecond');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes).toEqual(['first']);
  });

  it('turns a foreign composer after a soft newline into unknown without typing the next line', async () => {
    const backend = new ComposerBackend();
    backend.onWrite = data => {
      if (data === 'Enter') { backend.onWrite = undefined; backend.screen = box('/compact'); }
    };
    const pending = writeClaudeFamilyInput(backend, 'first\nsecond');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toBeInstanceOf(DriverRecoveryError);
    expect(backend.writes).toEqual(['first', '\\', 'Enter']);
  });

  it('turns a slash palette after a bare-PTY paste into unknown without final Enter', async () => {
    const backend = bare();
    backend.onWrite = data => {
      if (data.includes('business body')) { backend.onWrite = undefined; backend.screen = palette; }
    };
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes).toEqual(['\x1b[200~business body\x1b[201~']);
  });

  it('accepts Claude collapsing its own in-progress multiline chunks into a paste summary', async () => {
    const backend = new ComposerBackend();
    backend.onWrite = () => { backend.screen = box('[Pasted text #1 +1 lines]').replace('? for shortcuts', 'paste again to expand'); };
    await finish(writeClaudeFamilyInput(backend, 'first\nsecond'));
    expect(backend.writes).toEqual(['first', '\\', 'Enter', 'second', 'Enter']);
  });

  it('accepts its own chunked multiline echo and submits exactly once', async () => {
    const backend = new ComposerBackend();
    let draft = '';
    backend.onWrite = data => {
      if (data === 'Enter' && draft) { draft += '\n'; backend.screen = box(draft); }
      else if (data !== 'Enter' && data !== '\\') { draft += data; backend.screen = box(draft); }
    };
    await finish(writeClaudeFamilyInput(backend, 'first\nsecond'));
    expect(backend.writes).toEqual(['first', '\\', 'Enter', 'second', 'Enter']);
  });

  it('accepts the compact placeholder and a multiline paste summary as its own echo', async () => {
    const compact = new ComposerBackend();
    compact.onWrite = data => {
      if (data === '/compact') compact.screen = box('/compact  <optional custom summarization instructions>');
    };
    await finish(writeClaudeFamilyInput(compact, '/compact'));
    expect(compact.writes).toEqual(['/compact', 'Enter']);

    const pasted = bare();
    pasted.onWrite = data => {
      if (data.includes('first\nsecond')) pasted.screen = box('[Pasted text #1 +1 lines]');
    };
    await finish(writeClaudeFamilyInput(pasted, 'first\nsecond'));
    expect(pasted.writes).toEqual(['\x1b[200~first\nsecond\x1b[201~', '\r']);
  });

  it('accepts a bare-PTY viewport filled by its own long paste tail', async () => {
    const visibleTail = 'last routing line\n# Skill: acceptance-skill\nPath: /tmp/skill/SKILL.md\n\nVERIFY_CLAUDE_SKILL_DELIVERY';
    const prompt = `a long routing prefix that scrolled away\n${visibleTail}`;
    const backend = bare();
    // The wrapped viewport is an exact suffix after whitespace canonicalization.
    backend.onWrite = data => {
      if (data.includes(prompt)) backend.screen = `last routing line\n# Skill: acceptance-skill\nPath: /tmp/skill/\nSKILL.md\nVERIFY_CLAUDE_SKILL_DELIVERY^[[201~`;
    };
    await finish(writeClaudeFamilyInput(backend, prompt));
    expect(backend.writes).toEqual([`\x1b[200~${prompt}\x1b[201~`, '\r']);
  });

  it('rejects foreign text after the bare-PTY paste end marker', async () => {
    const backend = bare();
    backend.onWrite = data => {
      if (data.includes('business body')) backend.screen = 'business body^[[201~\nforeign draft';
    };
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes).toEqual(['\x1b[200~business body\x1b[201~']);
  });
});
