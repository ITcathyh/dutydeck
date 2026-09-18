import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LegacyImportError } from './types.js';

export interface StableFileSnapshot {
  bytes: Uint8Array;
  mode: number;
  size: number;
  mtime_ms: number;
  inode: bigint;
  device: bigint;
}

function sameStat(
  left: { size: bigint | number; mtimeMs: bigint | number; ino: bigint | number; dev: bigint | number },
  right: { size: bigint | number; mtimeMs: bigint | number; ino: bigint | number; dev: bigint | number }
): boolean {
  return BigInt(left.size) === BigInt(right.size)
    && BigInt(left.mtimeMs) === BigInt(right.mtimeMs)
    && BigInt(left.ino) === BigInt(right.ino)
    && BigInt(left.dev) === BigInt(right.dev);
}

export async function canonicalDirectory(path: string, pathRef: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new LegacyImportError('SOURCE_DIRECTORY_INVALID', 'Botmux source directory must be a real directory', pathRef);
    }
    return await realpath(path);
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError('SOURCE_DIRECTORY_UNREADABLE', 'Botmux source directory is unavailable', pathRef);
  }
}

export async function stableReadFile(
  path: string,
  artifactRef: string,
  options: { secret?: boolean } = {}
): Promise<StableFileSnapshot> {
  let handle;
  try {
    const linkInfo = await lstat(path);
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw new LegacyImportError('SOURCE_FILE_INVALID', 'Botmux source artifact must be a regular non-symlink file', artifactRef);
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new LegacyImportError('SOURCE_FILE_INVALID', 'Botmux source artifact must be a regular file', artifactRef);
    if (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) {
      throw new LegacyImportError('SOURCE_OWNER_MISMATCH', 'Botmux source artifact is not owned by the current user', artifactRef);
    }
    const mode = Number(before.mode) & 0o777;
    if ((mode & 0o022) !== 0) {
      throw new LegacyImportError('SOURCE_MODE_UNSAFE', 'Botmux source artifact is group/other writable', artifactRef);
    }
    if (options.secret && (mode & 0o077) !== 0) {
      throw new LegacyImportError('SOURCE_SECRET_MODE_UNSAFE', 'Credential-bearing Botmux source artifact must be private', artifactRef);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameStat(before, after)) {
      throw new LegacyImportError('SOURCE_CHANGED_DURING_READ', 'Botmux source artifact changed while being read', artifactRef);
    }
    return {
      bytes,
      mode,
      size: Number(after.size),
      mtime_ms: Number(after.mtimeMs),
      inode: after.ino,
      device: after.dev
    };
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError('SOURCE_FILE_UNREADABLE', 'Botmux source artifact could not be read safely', artifactRef);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function safeDirectoryEntries(path: string, pathRef: string): Promise<Array<{ name: string; kind: 'file' | 'directory' | 'other' }>> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new LegacyImportError('SOURCE_DIRECTORY_INVALID', 'Botmux source directory must be a real directory', pathRef);
    }
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
    }));
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError('SOURCE_DIRECTORY_UNREADABLE', 'Botmux source directory could not be listed safely', pathRef);
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function resolveInputPath(base: string, value: string): string {
  return resolve(base, value);
}
