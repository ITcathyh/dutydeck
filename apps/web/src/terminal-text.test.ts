import { Terminal } from '@xterm/xterm';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { terminalText } from './terminal-text';

// Only color parsing probes canvas at import time; the buffer parser runs without a renderer.
const canvas = vi.hoisted(() => vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null));
afterAll(() => canvas.mockRestore());

const terminals: Terminal[] = [];
async function buffer(text: string, cols = 8, rows = 5) {
  const term = new Terminal({ cols, rows, scrollback: 30, allowProposedApi: true });
  terminals.push(term);
  await new Promise<void>(resolve => term.write(text, resolve));
  return term.buffer.active;
}
afterEach(() => { terminals.splice(0).forEach(term => term.dispose()); });

it('joins actual xterm wraps and keeps printed spaces, indentation, and trailing spaces', async () => {
  const active = await buffer('  ab  cd  ef  \r\nnext  ');
  expect(terminalText(active, 0, 2).text).toBe('  ab  cd  ef  \nnext  ');
});

it('drops the spare column before CJK/emoji wraps and their continuation cells without losing real spaces', async () => {
  const active = await buffer('1234567中🙂  ok');
  expect(active.getLine(1)?.isWrapped).toBe(true);
  expect(terminalText(active, 0, 2).text).toBe('1234567中🙂  ok\n');
  const spaced = await buffer('123456 中🙂');
  expect(terminalText(spaced, 0, 1).text).toBe('123456 中🙂');
});

it('expands a viewport or selected row in the middle of a logical line, and locates the pressed line', async () => {
  const active = await buffer('before\r\nabcdefghijklmnopqrstuvwx\r\nafter');
  const snapshot = terminalText(active, 2, 2, { anchor: 2 });
  expect(snapshot.text).toBe('abcdefghijklmnopqrstuvwx');
  expect(snapshot.selection).toEqual([0, 24]);
});

it('copies only selected columns, including across a wrap, without neighbouring text', async () => {
  const active = await buffer('secret: ABCDEFGHIJ private', 12);
  expect(terminalText(active, 0, 1, { columns: { start: 8, end: 5 } }).text).toBe('ABCDEFGHI');
});

it('reads the scrolled viewport rather than the latest screen and retains hard line breaks', async () => {
  const active = await buffer('zero\r\none\r\ntwo\r\nthree\r\nfour\r\nfive', 8, 2);
  expect(active.baseY).toBeGreaterThan(0);
  expect(terminalText(active, 1, 2).text).toBe('one\ntwo');
});

it('limits screen columns to the current grid when a retained buffer row is longer', async () => {
  const active = await buffer('visible hidden', 20);
  expect(terminalText(active, 0, 0, { width: 7 }).text).toBe('visible');
});
