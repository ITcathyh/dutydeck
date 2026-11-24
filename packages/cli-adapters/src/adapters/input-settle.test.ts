import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverRecoveryError, PromptNotWrittenError } from '@dutydeck/shared';
import { ownedClaudeComposer, ownedClaudeComposerWithWrap, writeClaudeFamilyInput } from './claude-family.js';
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
  private draft = '';

  constructor(outputAt: number, processKey: object = {}) {
    this.outputAt = outputAt;
    this.processKey = processKey;
  }
  lastOutputAt(): number { return this.outputAt; }
  readScreen(): string { return `──────────\n❯${this.draft ? ` ${this.draft}` : ''}\n──────────\n? for shortcuts`; }
  write(data: string): void { this.record(data); }
  sendText(text: string): void { this.record(text); }
  sendSpecialKeys(...keys: string[]): void { this.record(keys.join('+')); }
  pasteText(text: string): void { this.record(text); }
  private record(data: string): void {
    this.writes.push({ at: Date.now(), data });
    if (!this.echo) return;
    const echo = () => {
      this.draft = data === 'Enter' || data === '\r' ? '' : this.draft + data;
      this.outputAt = Date.now();
    };
    if (this.echoDelayMs === 0) echo();
    else setTimeout(echo, this.echoDelayMs);
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

  it('does not submit after the echo timeout without a complete owned composer', async () => {
    const start = Date.now();
    const backend = new EchoingBackend(start - 60_000);
    backend.echo = false;
    const pending = writeClaudeFamilyInput(backend, 'hello');
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes[0]!.at - start).toBe(200);
    expect(backend.writes.map(write => write.data)).toEqual(['hello']);
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
    let draft = '';
    const readScreen = () => `──────────\n❯${draft ? ` ${draft}` : ''}\n──────────\n? for shortcuts`;
    const claude = writeClaudeFamilyInput({ write: data => {
      writes.push(data);
      draft = data === '\r' ? '' : draft + data;
    }, readScreen }, 'hello');
    await vi.advanceTimersByTimeAsync(800);
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
  const palette = '──────────\n❯ /compact\n──────────\n/compact  Free up context by summarizing the conversation so far\n/clear  Clear conversation';

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

  it('accepts a minimal ordinary prompt before and after bare-PTY keyed input', async () => {
    const initial = 'Claude Code v2.1.267 (mock)\r\n❯ \r\n';
    const backend = bare(initial);
    backend.onWrite = data => {
      if (data === 'business body') backend.screen = 'Claude Code v2.1.267 (mock)\n❯ business body';
    };
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await finish(pending);
    expect(backend.writes).toEqual(['business body', '\r']);
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
    expect(backend.writes).toEqual(['business body']);
  });

  it.each([
    ['ordinary empty composer', box()],
    ['native placeholder', box('Try "refactor <filepath>"')],
    ['permission footer', box().replace('? for shortcuts', '⏵⏵ bypass permissions on (shift+tab to cycle)')],
    ['two statusLine rows', box('', ['Context 18%', 'custom status'])],
    ['transient paste expansion hint', box().replace('? for shortcuts', 'paste again to expand')],
  ])('accepts the %s immediately before writing', async (_name, screen) => {
    const backend = new ComposerBackend(screen);
    backend.onWrite = data => {
      if (data === 'business body') backend.screen = screen.replace(/^❯.*$/m, '❯ business body');
    };
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
    expect(backend.writes).toEqual(['business body']);
  });

  it('rejects a paste summary even when it follows Dutydeck multiline chunks', async () => {
    const backend = new ComposerBackend();
    backend.onWrite = data => {
      if (data === 'first') backend.screen = box('[Pasted text #1 +1 lines]').replace('? for shortcuts', 'paste again to expand');
    };
    const pending = writeClaudeFamilyInput(backend, 'first\nsecond');
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes).toEqual(['first']);
  });

  it('accepts its own chunked multiline echo and submits exactly once', async () => {
    const backend = new ComposerBackend();
    let draft = '';
    backend.onWrite = data => {
      if (data === 'Enter' && draft) { draft += '\n'; backend.screen = box(draft); }
      else if (data !== 'Enter' && data !== '\\') { draft += data; backend.screen = box(draft); }
    };
    await finish(writeClaudeFamilyInput(backend, 'first\n\nsecond'));
    expect(backend.writes).toEqual(['first', '\\', 'Enter', '\\', 'Enter', 'second', 'Enter']);
  });

  it('accepts the compact placeholder but rejects a multiline paste summary', async () => {
    const compact = new ComposerBackend();
    compact.onWrite = data => {
      if (data === '/compact') compact.screen = box('/compact  <optional custom summarization instructions>');
    };
    await finish(writeClaudeFamilyInput(compact, '/compact'));
    expect(compact.writes).toEqual(['/compact', 'Enter']);

    const pasted = bare();
    pasted.onWrite = data => {
      if (data === 'first') pasted.screen = box('[Pasted text #1 +1 lines]');
    };
    const pending = writeClaudeFamilyInput(pasted, 'first\nsecond');
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(pasted.writes).toEqual(['first']);
  });

  it('reserves and restores the expanded input viewport around a successful write', async () => {
    const backend = new ComposerBackend();
    let draft = '';
    let begins = 0, restores = 0;
    Object.assign(backend, { beginExpandedInput: async () => { begins++; return async () => { restores++; }; } });
    backend.onWrite = data => {
      if (data === 'Enter' && draft) draft += '\n';
      else if (data !== 'Enter') draft += data;
      backend.screen = box(draft);
    };
    await finish(writeClaudeFamilyInput(backend, 'first\nsecond'));
    expect({ begins, restores }).toEqual({ begins: 1, restores: 1 });
    expect(backend.writes).toEqual(['first', '\\', 'Enter', 'second', 'Enter']);
  });

  it('restores the viewport after an unconfirmed write without retrying it', async () => {
    const backend = new ComposerBackend();
    let restores = 0;
    Object.assign(backend, { beginExpandedInput: async () => async () => { restores++; } });
    backend.onWrite = () => { backend.onWrite = undefined; backend.screen = box('foreign'); };
    const pending = writeClaudeFamilyInput(backend, 'business body');
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(restores).toBe(1);
    expect(backend.writes).toEqual(['business body']);
  });

  it('rejects a bare-PTY viewport containing only the owned long input tail', async () => {
    const visibleTail = 'VERIFY_CLAUDE_SKILL_DELIVERY';
    const prompt = `a long routing prefix that scrolled away ${visibleTail}`;
    const backend = bare();
    backend.onWrite = data => {
      if (data === prompt) backend.screen = box(visibleTail);
    };
    const pending = writeClaudeFamilyInput(backend, prompt);
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes).toEqual([prompt]);
  });

  it('rejects foreign text after the bare-PTY keyed echo', async () => {
    const backend = bare();
    backend.onWrite = data => {
      if (data === 'business body') backend.screen = box('business body\nforeign draft');
    };
    const pending = writeClaudeFamilyInput(backend, 'business body');
    void pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).rejects.toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes).toEqual(['business body']);
  });

  it('polls fresh final evidence when the first final read still shows the old empty composer', async () => {
    const backend = new ComposerBackend();
    backend.onWrite = data => {
      if (data === 'business body') {
        backend.screen = box();
        setTimeout(() => { backend.screen = box(data); }, 600);
      }
    };
    await finish(writeClaudeFamilyInput(backend, 'business body'));
    expect(backend.writes).toEqual(['business body', 'Enter']);
  });

  it('accepts exact semantic leading and trailing whitespace', async () => {
    const prompt = '  business body \t';
    const backend = new ComposerBackend();
    backend.onWrite = data => { if (data === prompt) backend.screen = box(prompt); };
    await finish(writeClaudeFamilyInput(backend, prompt));
    expect(backend.writes).toEqual([prompt, 'Enter']);
  });

  it('continues a multiline write when the updater reports failure below the mode footer', async () => {
    const backend = new ComposerBackend();
    const notice = '\n   ✘ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code';
    let draft = '';
    backend.onWrite = data => {
      draft += data === 'Enter' ? '\n' : data;
      backend.screen = box(draft) + notice;
    };
    await finish(writeClaudeFamilyInput(backend, 'first\nsecond'));
    expect(backend.writes).toEqual(['first', '\\', 'Enter', 'second', 'Enter']);
    expect(ownedClaudeComposer(box('first') + notice + ' Extra text', 'first')).toBe(false);
  });

  it('accepts the native non-breaking prompt separator without trimming the draft', async () => {
    const prompt = '  business body ';
    const backend = new ComposerBackend();
    backend.onWrite = data => { if (data === prompt) backend.screen = box(prompt).replace('❯ ', '❯ '); };
    await finish(writeClaudeFamilyInput(backend, prompt));
    expect(backend.writes).toEqual([prompt, 'Enter']);
  });

  it('removes only the two native continuation-indent spaces', () => {
    expect(ownedClaudeComposer(box('first\n  second').replace('❯ ', '❯ '), 'first\nsecond', true)).toBe(true);
    expect(ownedClaudeComposer(box('first\n    second').replace('❯ ', '❯ '), 'first\n  second', true)).toBe(true);
    expect(ownedClaudeComposer(box('first\n    second').replace('❯ ', '❯ '), 'first\nsecond', true)).toBe(false);
  });

  it('accepts only the intermediate pre-repaint soft-newline row from the recorded first-turn failure', async () => {
    vi.useRealTimers();
    const logical = [
      '<dutydeck_routing>',
      '  你运行在一个 IM 桥接的会话中：用户看不到你的终端，只能看到你回传的内容。',
      '  多行或长内容用引号 / heredoc 包裹，避免被拆成多条消息。',
      '  需要向用户回传内容时，直接输出文本即可（本会话未启用专用回传命令）。',
    ];
    const expected = logical.map(line => `${line}\\\n`).join('');
    const border = '─'.repeat(120);
    // The fourth soft Enter has returned, but Claude has not painted its blank
    // continuation row yet: only the last soft-newline backslash is visible.
    const captured = [
      border, `❯ ${logical[0]}`,
      ...logical.slice(1, 3).map(line => `  ${line}`),
      `  ${logical[3]}\\`,
      border, '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(await ownedClaudeComposerWithWrap(captured, expected, false)).toBe(true);
    expect(await ownedClaudeComposerWithWrap(captured, expected, true)).toBe(false);
    const foreign = captured.replace(`${logical[3]}\\`, `${logical[3]}\\foreign`);
    expect(foreign).not.toBe(captured);
    expect(await ownedClaudeComposerWithWrap(foreign, expected, false)).toBe(false);
  });

  it('joins only full-width native physical rows, including wide characters', async () => {
    vi.useRealTimers();
    const asciiWrap = box('abcdef\n  gh').replace('❯ ', '❯ ');
    expect(await ownedClaudeComposerWithWrap(asciiWrap, 'abcdefgh', true)).toBe(true);
    expect(await ownedClaudeComposerWithWrap(asciiWrap, 'abcdef\ngh', true)).toBe(false);
    expect(await ownedClaudeComposerWithWrap(box('abc\n  gh').replace('❯ ', '❯ '), 'abc\ngh', true)).toBe(true);
    expect(await ownedClaudeComposerWithWrap(box('一二三\n  四').replace('❯ ', '❯ '), '一二三四', true)).toBe(true);
  });

  it('treats the native empty NBSP composer as an intermediate lag, never a final draft', () => {
    const screen = box().replace('❯', '❯ ');
    expect(ownedClaudeComposer(screen, 'business body', false)).toBe(true);
    expect(ownedClaudeComposer(screen, 'business body', true)).toBe(false);
  });

  it.each(['', ' \t'])('rejects an empty or whitespace-only prompt without writing: %j', async prompt => {
    const backend = new ComposerBackend();
    const pending = writeClaudeFamilyInput(backend, prompt);
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(backend.writes).toEqual([]);
  });

  it('rejects unverifiable trailing whitespace before a hard newline without writing', async () => {
    const backend = new ComposerBackend();
    const pending = writeClaudeFamilyInput(backend, 'first  \nsecond');
    await expect(pending).rejects.toBeInstanceOf(PromptNotWrittenError);
    expect(backend.writes).toEqual([]);
  });

  it.each([
    ['empty', 'business body', box()],
    ['strict prefix', 'business body', box('business')],
    ['semantic whitespace removed', 'business body', box('businessbody')],
    ['semantic blank line removed', 'first\n\nsecond', box('first\nsecond')],
    ['semantic blank line added', 'first\nsecond', box('first\n\nsecond')],
    ['leading whitespace stripped', '  business body', box('business body')],
    ['leading whitespace added', 'business body', box('  business body')],
    ['trailing whitespace stripped', 'business body  ', box('business body')],
    ['trailing whitespace added', 'business body', box('business body  ')],
    ['suffix only', 'business body', box('body')],
    ['foreign paste summary', 'first\nsecond', box('[Pasted text #7 +2 lines]')],
  ])('rejects an %s composer instead of guessing ownership before final Enter', async (_name, prompt, visible) => {
    const backend = bare();
    backend.onWrite = () => { backend.onWrite = undefined; backend.screen = visible; };
    const pending = writeClaudeFamilyInput(backend, prompt);
    const outcome = pending.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await outcome).toMatchObject({ name: 'DriverRecoveryError', code: 'DRIVER_INPUT_UNCONFIRMED' });
    expect(backend.writes.at(-1)).not.toBe('\r');
  });

  it('accepts only the exact business /compact palette produced by its own draft', async () => {
    const backend = bare();
    backend.onWrite = () => { backend.onWrite = undefined; backend.screen = palette; };
    await finish(writeClaudeFamilyInput(backend, '/compact'));
    expect(backend.writes.at(-1)).toBe('\r');
  });

  it('accepts only the exact native compact command menu', () => {
    const menu = [
      'previous answer', '',
      '❯ /compact Free up context by summarizing the conversation so far',
      '/autocompact Set how full the context gets before auto-summarizing',
      '', '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(ownedClaudeComposer(menu, '/compact', true)).toBe(true);
    expect(ownedClaudeComposer(menu.replace('Free up context', 'Free up context!'), '/compact', true)).toBe(false);
    expect(ownedClaudeComposer(menu.replace('❯ /compact', '❯ /autocompact'), '/compact', true)).toBe(false);
    expect(ownedClaudeComposer(menu.replace('/autocompact', '/clear'), '/compact', true)).toBe(false);
  });

  it('accepts the Claude 2.1.295 aligned compact menu above its owned composer', async () => {
    const border = '─'.repeat(120);
    const menu = [
      '  ❯ /compact                    Free up context by summarizing the conversation so far',
      '    /autocompact                Set how full the context gets before auto-summarizing',
      border, '❯ /compact ', border, '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    const backend = bare();
    backend.onWrite = () => { backend.onWrite = undefined; backend.screen = menu; };
    await finish(writeClaudeFamilyInput(backend, '/compact'));
    expect(backend.writes).toEqual(['/compact', '\r']);
    expect(ownedClaudeComposer(menu.replace('Free up context', 'Free up context!'), '/compact', true)).toBe(false);
    expect(ownedClaudeComposer(menu.replace('❯ /compact', '❯ /clear'), '/compact', true)).toBe(false);
    expect(ownedClaudeComposer(menu.replace('/autocompact', '/clear'), '/compact', true)).toBe(false);
  });

  it('classifies custom screen read failures by the first real write', async () => {
    for (const afterWrite of [false, true]) {
      const writes: string[] = [];
      let reads = 0;
      const pending = writeClaudeFamilyInput({
        processKey: {}, lastOutputAt: () => Date.now() - 60_000,
        readScreen: () => { if (afterWrite && reads++ > 0) throw new Error('EIO'); if (!afterWrite) throw new Error('EIO'); return box(); },
        write(data) { writes.push(data); },
      }, 'business body');
      const outcome = pending.then(() => undefined, error => error);
      await vi.advanceTimersByTimeAsync(15_000);
      const error = await outcome;
      expect(error).toBeInstanceOf(afterWrite ? DriverRecoveryError : PromptNotWrittenError);
      expect(writes.length > 0).toBe(afterWrite);
      expect(writes.at(-1)).not.toBe('\r');
    }
  });

  it('keeps first-write warmup until a real backend write succeeds', async () => {
    const processKey = {};
    const rejected = new EchoingBackend(Date.now() - 60_000, processKey);
    rejected.readScreen = () => box('human draft');
    const first = writeClaudeFamilyInput(rejected, 'business body');
    const firstOutcome = first.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await firstOutcome).toBeInstanceOf(PromptNotWrittenError);

    const start = Date.now();
    const second = new EchoingBackend(start - 60_000, processKey);
    await run(writeClaudeFamilyInput(second, 'business body'));
    expect(second.writes[0]!.at - start).toBe(200);
  });

  it('accepts exact single-line text continued across minimal renderer rows', async () => {
    const prompt = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(3);
    const backend = new ComposerBackend('Claude Code v2.1.267 (mock)\n❯');
    let draft = '';
    backend.onWrite = data => {
      if (data === 'Enter') return;
      draft += data;
      const rows = (`❯ ${draft}`).match(/.{1,24}/g) ?? [];
      backend.screen = `Claude Code v2.1.267 (mock)\n${rows.join('\n')}`;
    };
    await finish(writeClaudeFamilyInput(backend, prompt));
    expect(backend.writes.at(-1)).toBe('Enter');
  });

  it('counts the explicit soft-newline marker as its own visible input', async () => {
    const backend = new ComposerBackend();
    let draft = '';
    backend.onWrite = data => {
      if (data === '\\') { draft += '\\'; backend.screen = box(draft); return; }
      if (data === 'Enter' && draft.endsWith('\\')) { draft = `${draft.slice(0, -1)}\n`; backend.screen = box(draft); return; }
      if (data !== 'Enter') { draft += data; backend.screen = box(draft); }
    };
    await finish(writeClaudeFamilyInput(backend, 'first\n\nsecond'));
    expect(backend.writes).toEqual(['first', '\\', 'Enter', '\\', 'Enter', 'second', 'Enter']);
  });
});
