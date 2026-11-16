/**
 * Tests for TerminalSnapshot: ANSI stripping, box-drawing cleanup,
 * prompt-line filtering, and viewport semantics.
 *
 * Run: pnpm vitest run packages/terminal-renderer
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { TerminalScreen } from '@dutydeck/shared';
import { TerminalSnapshot } from './index.js';

type SnapshotInternals = {
  serializer: { serialize(): string };
  sgrMouse: boolean;
  cursorVisible: boolean;
  textCache: Map<string, string>;
};

function internals(snap: TerminalSnapshot): SnapshotInternals {
  return snap as unknown as SnapshotInternals;
}

function capture(snap: TerminalSnapshot): Promise<TerminalScreen> {
  return new Promise(resolve => snap.capture(resolve));
}

async function restoredViewport(screen: TerminalScreen): Promise<string> {
  const restored = new TerminalSnapshot(screen.cols, screen.rows);
  try {
    await restored.writeAndFlush(screen.data);
    return restored.viewportText();
  } finally { restored.dispose(); }
}

type CaptureRecord = {
  screen: TerminalScreen;
  text: string;
  viewport: string;
  structure: string;
  lastLine: string;
};

/** Compare capture with the previous uncached serialization at the same write boundary. */
async function captureRecord(snap: TerminalSnapshot): Promise<CaptureRecord> {
  const { record, uncached } = await new Promise<{
    record: CaptureRecord;
    uncached: TerminalScreen;
  }>(resolve => snap.capture(screen => {
    const state = internals(snap);
    resolve({
      record: {
        screen,
        text: snap.text(),
        viewport: snap.viewportText(),
        structure: snap.viewportText({ preserveStructure: true }),
        lastLine: snap.lastLine(),
      },
      uncached: {
        data: state.serializer.serialize() + (state.sgrMouse ? '\x1b[?1006h' : '')
          + (state.cursorVisible ? '' : '\x1b[?25l'),
        cols: snap.xterm.cols,
        rows: snap.xterm.rows,
      },
    });
  }));
  expect(record.screen).toEqual(uncached);
  return record;
}

/** xterm's write() is async; flush a macrotask so the buffer catches up. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('TerminalSnapshot', () => {
  it('loads xterm and the serializer only when the first snapshot is constructed', () => {
    const require = createRequire(import.meta.url);
    const headless = require.resolve('@xterm/headless'), serialize = require.resolve('@xterm/addon-serialize');
    expect(require.cache[headless]).toBeUndefined();
    expect(require.cache[serialize]).toBeUndefined();
    const snap = new TerminalSnapshot();
    expect(require.cache[headless]).toBeDefined();
    expect(require.cache[serialize]).toBeDefined();
    snap.dispose();
  });

  it('defaults to 120x30', () => {
    const snap = new TerminalSnapshot();
    expect(snap.xterm.cols).toBe(120);
    expect(snap.xterm.rows).toBe(30);
    snap.dispose();
  });

  it('honours explicit cols/rows and resize()', () => {
    const snap = new TerminalSnapshot(80, 24);
    expect(snap.xterm.cols).toBe(80);
    expect(snap.xterm.rows).toBe(24);
    snap.resize(200, 50);
    expect(snap.xterm.cols).toBe(200);
    expect(snap.xterm.rows).toBe(50);
    snap.dispose();
  });

  it('strips ANSI escapes, cleans box drawing, and filters prompt lines', async () => {
    const snap = new TerminalSnapshot(80, 24);
    // Simulated Claude Code TUI frame: colourised border, assistant text,
    // a bare prompt line, and an input-echo line.
    snap.write([
      '\x1b[2K\x1b[1G┌──────────────────────────────────┐',
      '\x1b[2K\x1b[1G│ \x1b[1mWelcome to Claude Code\x1b[0m          │',
      '\x1b[2K\x1b[1G└──────────────────────────────────┘',
      '\x1b[2K\x1b[1G',
      '\x1b[2K\x1b[1G\x1b[36m✻\x1b[0m Here is the answer you asked for.',
      '\x1b[2K\x1b[1GIt spans two lines of assistant output.',
      '\x1b[2K\x1b[1G',
      '\x1b[2K\x1b[1G❯',
      '\x1b[2K\x1b[1G❯ rm -rf /tmp/scratch',
    ].join('\r\n'));
    await flush();

    const text = snap.text();
    // Key assistant text survives.
    expect(text).toContain('Here is the answer you asked for.');
    expect(text).toContain('It spans two lines of assistant output.');
    // No ANSI residue.
    expect(text).not.toContain('\x1b');
    // No box-drawing characters.
    expect(text).not.toMatch(/[─━│┌┐└┘├┤┬┴┼╭╮╯╰]/);
    // Bare prompt line and input echo are filtered out.
    expect(text.split('\n')).not.toContain('❯');
    expect(text).not.toContain('rm -rf /tmp/scratch');
    // No leading/trailing blank lines.
    expect(text.startsWith('\n')).toBe(false);
    expect(text.endsWith('\n')).toBe(false);
    snap.dispose();
  });

  it('viewportText keeps a bare composer prompt and a selected menu entry', async () => {
    const snap = new TerminalSnapshot(80, 8);
    snap.write('Quick safety check:\r\n❯ Yes, I trust this folder\r\n❯\u00a0');
    await flush();
    expect(snap.text()).not.toContain('❯');
    expect(snap.viewportText()).toContain('❯ Yes, I trust this folder');
    expect(snap.viewportText()).toContain('❯');
    snap.dispose();
  });

  it('collapses runs of spaces left by box-drawing cleanup', async () => {
    const snap = new TerminalSnapshot(80, 10);
    snap.write('┌────┐\r\n│ hi │\r\n└────┘');
    await flush();
    const text = snap.text();
    expect(text).not.toMatch(/  +/);
    expect(text).toContain('hi');
    snap.dispose();
  });

  it('reads only the current viewport (scrollback excluded)', async () => {
    const snap = new TerminalSnapshot(80, 3);
    snap.write([
      'STALE_STARTUP_DIALOG',
      'old output 1',
      'old output 2',
      'current output',
      'CURRENT_PROMPT',
    ].join('\r\n'));
    await flush();

    const text = snap.text();
    expect(text).not.toContain('STALE_STARTUP_DIALOG');
    expect(text).toContain('CURRENT_PROMPT');
    snap.dispose();
  });
});

it('serializes history, cursor, alternate screen and mouse encoding at the queued boundary', async () => {
  const source = new TerminalSnapshot(40, 4);
  const restored = new TerminalSnapshot(40, 4);
  try {
    source.write('old 1\r\nold 2\r\nold 3\r\nold 4\r\nnormal prompt');
    source.write('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[?2004h\x1b[2;3H\x1b[31mALT');
    const screen = await new Promise<{ data: string }>(resolve => source.capture(resolve));
    expect(screen.data).toContain('\x1b[?1006h');
    expect(screen.data).toContain('\x1b[?25l');
    await restored.writeAndFlush(screen.data);
    expect(restored.xterm.buffer.active.type).toBe('alternate');
    expect(restored.xterm.modes.mouseTrackingMode).toBe('vt200');
    expect(restored.xterm.modes.bracketedPasteMode).toBe(true);
    expect(restored.xterm.buffer.active.cursorX).toBe(5);
    expect(restored.xterm.buffer.active.cursorY).toBe(1);
    await restored.writeAndFlush('\x1b[?1049l');
    expect(restored.xterm.buffer.active.baseY).toBe(1);
    expect(restored.xterm.buffer.active.getLine(0)?.translateToString(true)).toBe('old 1');
    expect(restored.viewportText()).toContain('normal prompt');
  } finally { source.dispose(); restored.dispose(); }
});


it('preserves structural characters and spacing only on request, within the current viewport', async () => {
  const snap = new TerminalSnapshot(80, 3);
  try {
    await snap.writeAndFlush('STALE BORDER ────────\r\nold output\r\n\x1b[36m────────────────\x1b[0m\r\n❯  draft\r\n────────────────');
    expect(snap.viewportText()).not.toContain('─');
    const structural = snap.viewportText({ preserveStructure: true });
    expect(structural).toBe('────────────────\n❯  draft\n────────────────');
    expect(structural).not.toContain('STALE BORDER');
    expect(structural).not.toContain('\x1b');
  } finally { snap.dispose(); }
});

it('never serves screen text from before a parsed write or resize', async () => {
  const snap = new TerminalSnapshot(20, 3);
  try {
    await snap.writeAndFlush('first');
    expect(snap.text()).toBe('first');
    expect(snap.lastLine()).toBe('first');
    // Queued but unparsed bytes are not on screen yet.
    snap.write('\r\nsecond');
    expect(snap.viewportText()).toBe('first');
    await flush();
    expect(snap.viewportText()).toBe('first\nsecond');
    expect(snap.lastLine()).toBe('second');
    // The flush barrier itself observes the parsed chunk.
    await snap.writeAndFlush('\x1b[2J\x1b[Hthird');
    expect(snap.text()).toBe('third');
    await snap.writeAndFlush('\r\n' + 'x'.repeat(20) + 'tail');
    expect(snap.viewportText()).toBe('third\n' + 'x'.repeat(20) + '\ntail');
    snap.resize(20, 2);
    expect(snap.viewportText()).toBe('x'.repeat(20) + '\ntail');
  } finally { snap.dispose(); }
});

describe('TerminalSnapshot capture cache', () => {
  it('reuses the serializer base within a revision and invalidates it on writes and resize', async () => {
    const snap = new TerminalSnapshot(40, 4);
    const serialize = vi.spyOn(internals(snap).serializer, 'serialize');
    try {
      await snap.writeAndFlush('\x1b[31mred\x1b[0m');
      const first = await capture(snap);
      expect(await capture(snap)).toEqual(first);
      expect(serialize).toHaveBeenCalledTimes(1);

      await snap.writeAndFlush('\x1b[32mgreen');
      await capture(snap);
      expect(serialize).toHaveBeenCalledTimes(2);

      snap.write('!');
      await flush();
      await capture(snap);
      expect(serialize).toHaveBeenCalledTimes(3);

      await snap.writeAndFlush('\x1b[?1049h\x1b[H\x1b[38;2;1;2;3mALT');
      expect((await capture(snap)).data).toContain('\x1b[?1049h');
      expect(serialize).toHaveBeenCalledTimes(4);

      await snap.writeAndFlush('\x1b[?1006h\x1b[?25l');
      const modesMiss = await capture(snap);
      const modesHit = await capture(snap);
      expect(modesHit).toEqual(modesMiss);
      expect(modesHit.data.endsWith('\x1b[?1006h\x1b[?25l')).toBe(true);
      expect(serialize).toHaveBeenCalledTimes(5);

      await snap.writeAndFlush('\x1b[?1006l\x1b[?25h\x1b[0m');
      expect((await capture(snap)).data.endsWith('\x1b[?1006h\x1b[?25l')).toBe(false);
      expect(serialize).toHaveBeenCalledTimes(6);

      snap.resize(20, 3);
      expect(await capture(snap)).toMatchObject({ cols: 20, rows: 3 });
      expect(serialize).toHaveBeenCalledTimes(7);
    } finally {
      serialize.mockRestore();
      snap.dispose();
    }
  });

  it('captures queued writes at their own parsed boundaries', async () => {
    const snap = new TerminalSnapshot(20, 3);
    try {
      snap.write('A');
      const a = capture(snap);
      snap.write('B');
      const ab = capture(snap);
      const [screenA, screenAB] = await Promise.all([a, ab]);
      expect(await restoredViewport(screenA)).toBe('A');
      expect(await restoredViewport(screenAB)).toBe('AB');
    } finally { snap.dispose(); }
  });

  it('keeps alternating instances isolated', async () => {
    const a = new TerminalSnapshot(20, 3);
    const b = new TerminalSnapshot(20, 3);
    try {
      await a.writeAndFlush('AAAA\x1b[?1006h\x1b[?25l');
      await b.writeAndFlush('BBBB');
      const a1 = await capture(a);
      const b1 = await capture(b);
      expect(await capture(a)).toEqual(a1);
      expect(await capture(b)).toEqual(b1);
      expect(a1.data).not.toBe(b1.data);
      expect(a1.data.endsWith('\x1b[?1006h\x1b[?25l')).toBe(true);
      expect(b1.data.endsWith('\x1b[?1006h\x1b[?25l')).toBe(false);
    } finally { a.dispose(); b.dispose(); }
  });

  it('clears cached snapshots and text on dispose', async () => {
    const snap = new TerminalSnapshot(20, 3);
    const cache = internals(snap).textCache;
    await snap.writeAndFlush('content');
    await capture(snap);
    snap.text();
    expect(cache.size).toBeGreaterThan(0);
    snap.dispose();
    expect(cache.size).toBe(0);
  });

  it('matches uncached captures and every text read across modes, alt screen and resize', async () => {
    const snap = new TerminalSnapshot(40, 4);
    try {
      await snap.writeAndFlush(Array.from({ length: 12 }, (_, i) => `line-${i}-\x1b[31m红色`).join('\r\n'));
      const initial = await captureRecord(snap);
      expect(await captureRecord(snap)).toEqual(initial);

      const modes = [
        '\x1b[?1h', '\x1b[?66h', '\x1b[?2004h', '\x1b[4h', '\x1b[?6h',
        '\x1b[?45h', '\x1b[?1004h', '\x1b[?7l', '\x1b[?9h', '\x1b[?1000h',
        '\x1b[?1002h', '\x1b[?1003h', '\x1b[?1006l', '\x1b[?25h',
        '\x1b[?1006h', '\x1b[?25l', '\x1bc',
      ];
      for (const mode of modes) {
        await snap.writeAndFlush(mode);
        await captureRecord(snap);
      }

      await snap.writeAndFlush('\x1b[?1049h\x1b[H\x1b[38;2;1;2;3mALT-界面\x1b[?1000h\x1b[?1006h\x1b[?25l');
      const alt = await captureRecord(snap);
      expect(await captureRecord(snap)).toEqual(alt);
      expect(alt.screen.data).toContain('\x1b[?1049h');
      expect(alt.screen.data.endsWith('\x1b[?1006h\x1b[?25l')).toBe(true);

      await snap.writeAndFlush('\x1b[2;3H#');
      await captureRecord(snap);
      snap.resize(20, 3);
      expect((await captureRecord(snap)).screen).toMatchObject({ cols: 20, rows: 3 });
      snap.resize(60, 8);
      expect((await captureRecord(snap)).screen).toMatchObject({ cols: 60, rows: 8 });
      await snap.writeAndFlush('\x1b[?1049l');
      await captureRecord(snap);
      await snap.writeAndFlush('\x1b[4l\x1b[?6l\x1b[?45l\x1b[?1004l\x1b[?7h\x1b[?1003l\x1b[?2004l');
      await captureRecord(snap);
    } finally { snap.dispose(); }
  });
});
