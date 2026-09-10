/**
 * Headless terminal snapshot: feeds PTY data into an @xterm/headless
 * instance and exposes the current viewport as cleaned plain text.
 *
 * Ported from botmux src/utils/terminal-renderer.ts; the cleaning pipeline
 * (box-drawing strip, prompt-line filter, blank trim) is preserved verbatim.
 * Snapshot semantics match botmux's PNG path: both read the current viewport
 * [baseY, baseY + rows), which keeps text consistent for alt-screen CLIs
 * (Claude Code) where scrollback isn't meaningful.
 */
import xtermHeadless from '@xterm/headless';
import { createHash } from 'node:crypto';

const { Terminal } = xtermHeadless;

/** Strip box-drawing characters and collapse runs of spaces. */
function cleanBoxDrawing(line: string): string {
  return line
    .replace(/[─━│┌┐└┘├┤┬┴┼╭╮╯╰]/g, ' ')
    .replace(/  +/g, ' ')
    .trimEnd();
}

/** Bare prompt line: ❯ (Claude) or > (Aiden) with optional trailing whitespace */
const BARE_PROMPT_RE = /^[❯>]\s*$/;
/** Input echo: ❯ or > followed by user text */
const INPUT_ECHO_RE = /^[❯>]\s+\S/;
/** Empty or whitespace-only */
const BLANK_RE = /^\s*$/;

/** Hard upper bound — protects snapshot memory if a pane is reported as
 *  unreasonably wide. Below this, the actual read width is the xterm's real
 *  cols. Bumping past 320 risks a >5MB canvas per screenshot. */
const SNAPSHOT_COLS = 320;

/** Default viewport size when the caller does not specify dimensions. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/**
 * Read the current viewport of an xterm-headless Terminal as plain text.
 *
 * `filter=true` drops the bare-prompt line and the input-echo line — the
 * card text should show CLI output, not the live cursor reflection.
 */
function readViewportText(
  terminal: InstanceType<typeof Terminal>,
  opts: { filter: boolean; readCols?: number },
): string {
  const buffer = terminal.buffer.active;
  const readCols = Math.min(opts.readCols ?? SNAPSHOT_COLS, terminal.cols);
  const baseY = buffer.baseY;
  const rows = terminal.rows;
  const endY = baseY + rows;

  const lines: string[] = [];
  for (let y = baseY; y < endY; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const s = cleanBoxDrawing(line.translateToString(true, 0, readCols));
    if (opts.filter && (BARE_PROMPT_RE.test(s) || INPUT_ECHO_RE.test(s))) continue;
    lines.push(s);
  }

  if (opts.filter) {
    while (lines.length > 0 && BLANK_RE.test(lines[0]!)) lines.shift();
  }
  while (lines.length > 0 && BLANK_RE.test(lines[lines.length - 1]!)) lines.pop();

  return lines.join('\n');
}

/**
 * Accumulating headless terminal snapshot. Feed raw PTY bytes via write(),
 * then read the cleaned viewport via text().
 *
 * Note: xterm's write() is intentionally asynchronous — the write is queued
 * and parsed on the renderer's next tick. Callers that need the buffer to
 * reflect a write before reading text() should await a macrotask
 * (`await new Promise(r => setTimeout(r, 0))`) after the final write.
 */
export class TerminalSnapshot {
  private terminal: InstanceType<typeof Terminal>;
  private lastHash = '';

  constructor(cols: number = DEFAULT_COLS, rows: number = DEFAULT_ROWS) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true });
  }

  /** Feed raw PTY data into the virtual terminal. */
  write(data: string): void {
    this.terminal.write(data);
  }

  /**
   * Feed raw PTY data and wait until xterm has parsed every queued byte
   * through this write. Callers that inspect the buffer immediately
   * afterwards must use this barrier.
   */
  writeAndFlush(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.terminal.write(data, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  /** Resize the virtual terminal. */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /**
   * Filtered viewport text: ANSI stripped (by xterm itself), box-drawing
   * characters cleaned, bare-prompt and input-echo lines dropped, leading
   * and trailing blank lines trimmed.
   */
  text(): string {
    return readViewportText(this.terminal, { filter: true });
  }

  /**
   * Unfiltered viewport text for terminal interactions. Unlike text(), this
   * retains a bare composer prompt and menu selections so callers can make a
   * decision from the screen currently visible to the user.
   */
  viewportText(): string {
    return readViewportText(this.terminal, { filter: false });
  }

  /** Last non-empty logical line, joining physical rows wrapped by xterm. */
  lastLine(): string {
    const buffer = this.terminal.buffer.active;
    let row = buffer.baseY + this.terminal.rows - 1;
    while (row >= buffer.baseY && !buffer.getLine(row)?.translateToString(true).trim()) row--;
    if (row < buffer.baseY) return '';
    let line = buffer.getLine(row);
    let text = line?.translateToString(true) ?? '';
    while (line?.isWrapped && row > buffer.baseY) {
      line = buffer.getLine(--row);
      text = (line?.translateToString(false) ?? '') + text;
    }
    return cleanBoxDrawing(text).trim();
  }

  /**
   * Filtered viewport text with change detection — `changed` is false when
   * the text is byte-identical to the previous snapshot() call.
   */
  snapshot(): { content: string; changed: boolean } {
    const content = this.text();
    const hash = createHash('md5').update(content).digest('hex');
    const changed = hash !== this.lastHash;
    this.lastHash = hash;
    return { content, changed };
  }

  /** Reset the change-detection hash so the next snapshot registers as changed. */
  markNewTurn(): void {
    this.lastHash = '';
  }

  /** Expose the underlying xterm-headless instance (PNG rendering, etc.). */
  get xterm(): InstanceType<typeof Terminal> { return this.terminal; }

  dispose(): void {
    this.terminal.dispose();
  }
}
