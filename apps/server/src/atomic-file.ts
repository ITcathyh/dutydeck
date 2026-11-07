import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 先写同目录下的临时文件、fsync 后再 rename，最后 fsync 目录：并发读的一方只看到完整的旧内容或新内容，
 * 机器崩溃或断电后也不会留下截断、为空的文件。默认权限 0600；失败时删掉临时文件。
 */
export interface AtomicWriteOptions { mode?: number }

const temporaryPath = (path: string) => `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;

function syncDirectory(path: string) {
  let fd: number | undefined;
  // 有些文件系统不允许 fsync 目录；rename 本身已经生效，这里只是尽力落盘。
  try { fd = openSync(dirname(path), 'r'); fsyncSync(fd); } catch { /* best effort */ } finally { if (fd !== undefined) closeSync(fd); }
}

export function writeFileAtomicSync(path: string, content: string, options: AtomicWriteOptions = {}): void {
  const temporary = temporaryPath(path);
  try {
    const fd = openSync(temporary, 'wx', options.mode ?? 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  syncDirectory(path);
}

export async function writeFileAtomic(path: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  const temporary = temporaryPath(path);
  try {
    const handle = await open(temporary, 'wx', options.mode ?? 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  syncDirectory(path);
}
