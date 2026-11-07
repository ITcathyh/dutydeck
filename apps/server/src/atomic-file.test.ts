import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeFileAtomic, writeFileAtomicSync } from './atomic-file.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dutydeck-atomic-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it.each([['sync', writeFileAtomicSync], ['async', writeFileAtomic]] as const)('%s: replaces content, defaults to 0600 and leaves no temporary file', async (_kind, write) => {
  const file = join(dir, 'state.json');
  await write(file, 'old');
  await write(file, 'new');
  expect(await readFile(file, 'utf8')).toBe('new');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await write(join(dir, 'lock.json'), 'x', { mode: 0o644 });
  expect((await stat(join(dir, 'lock.json'))).mode & 0o777).toBe(0o644);
  expect((await readdir(dir)).sort()).toEqual(['lock.json', 'state.json']);
});

it.each([['sync', writeFileAtomicSync], ['async', writeFileAtomic]] as const)('%s: removes its temporary file when the rename fails', async (_kind, write) => {
  const target = join(dir, 'occupied');
  await mkdir(join(target, 'child'), { recursive: true });
  // 目标是非空目录，rename 失败。
  await expect(Promise.resolve().then(() => write(target, 'y'))).rejects.toThrow();
  expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
