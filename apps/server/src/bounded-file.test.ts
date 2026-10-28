import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readBoundedBytes } from './bounded-file.js';

it('continues after short reads, stops at EOF and never exceeds the byte allowance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-bounded-file-')); let file;
  try {
    const path = join(root, 'text'); await writeFile(path, 'abcdefgh'); file = await open(path, 'r');
    const read = file.read.bind(file);
    vi.spyOn(file, 'read').mockImplementation(async (buffer: any, offset: any, length: any, position: any) => read(buffer, offset, Math.min(length, 3), position));
    expect((await readBoundedBytes(file, 5)).toString()).toBe('abcde');
    expect((await readBoundedBytes(file, 20)).toString()).toBe('abcdefgh');
  } finally { await file?.close(); await rm(root, { recursive: true, force: true }); }
});
