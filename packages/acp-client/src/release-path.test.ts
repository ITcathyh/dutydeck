import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { currentReleasePath } from './release-path.js';

it('只在 releases/current 指向本版本时改用经过 current 的启动器路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dd-release-path-'));
  try {
    const launcher = (release: string) => join(root, 'releases', release, 'dist', 'agents', 'env-launcher.mjs');
    for (const release of ['r1', 'r2']) {
      await mkdir(join(root, 'releases', release, 'dist', 'agents'), { recursive: true });
      await writeFile(launcher(release), '');
    }
    expect(currentReleasePath(launcher('r1'))).toBe(launcher('r1'));
    await symlink('r1', join(root, 'releases', 'current'));
    expect(currentReleasePath(launcher('r1'))).toBe(launcher('current'));
    expect(currentReleasePath(launcher('r2'))).toBe(launcher('r2'));
    expect(currentReleasePath(join(root, 'dist', 'agents', 'env-launcher.mjs'))).toBe(join(root, 'dist', 'agents', 'env-launcher.mjs'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
