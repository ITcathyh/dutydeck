/**
 * Tests for TerminalSnapshot: ANSI stripping, box-drawing cleanup,
 * prompt-line filtering, and viewport semantics.
 *
 * Run: pnpm vitest run packages/terminal-renderer
 */
import { describe, it, expect } from 'vitest';
import { TerminalSnapshot } from './index.js';

/** xterm's write() is async; flush a macrotask so the buffer catches up. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20));
}

describe('TerminalSnapshot', () => {
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

  it('snapshot() reports changed=false on identical text', async () => {
    const snap = new TerminalSnapshot(80, 5);
    snap.write('stable content\r\n');
    await flush();
    expect(snap.snapshot().changed).toBe(true);
    expect(snap.snapshot().changed).toBe(false);
    snap.markNewTurn();
    expect(snap.snapshot().changed).toBe(true);
    snap.dispose();
  });
});
