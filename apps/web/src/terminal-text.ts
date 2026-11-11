import type { IBuffer } from '@xterm/xterm';

/** Snapshot screen rows as complete logical lines, or only the selected columns when supplied. */
export function terminalText(buffer: IBuffer, first: number, last: number, options: { anchor?: number; width?: number; columns?: { start: number; end: number } } = {}): { text: string; selection?: [number, number] } {
  first = Math.max(0, first);
  last = Math.min(buffer.length - 1, last);
  if (!options.columns) {
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
    while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++;
  }
  let text = '', lineStart = 0;
  let selection: [number, number] | undefined;
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row > first && !line.isWrapped) { text += '\n'; lineStart = text.length; }
    const next = row < last ? buffer.getLine(row + 1) : undefined;
    let end = Math.min(line.length, options.width ?? line.length);
    if (!next?.isWrapped) {
      // Empty grid cells are padding; printed spaces have a codepoint and must survive.
      while (end > 0 && !line.getCell(end - 1)?.getCode()) end--;
    } else if (next.getCell(0)?.getWidth() === 2 && line.getCell(end - 1)?.getWidth() === 1 && !line.getCell(end - 1)?.getCode()) {
      // A wide glyph wraps with one spare column. That cell is not a typed space.
      end--;
    }
    if (row === last && options.columns) end = Math.min(end, options.columns.end);
    for (let column = row === first ? options.columns?.start ?? 0 : 0; column < end; column++) {
      const cell = line.getCell(column);
      if (cell && cell.getWidth() !== 0) text += cell.getChars() || ' ';
    }
    if (options.anchor !== undefined && row >= options.anchor && (!next?.isWrapped || row === last) && !selection) selection = [lineStart, text.length];
  }
  return { text, selection };
}
