import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { larkForkWorkspaceMode } from './session-branches.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('an unborn repository still requires a worktree; a placeholder .git is not a repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-fork-workspace-')); roots.push(root);
  await mkdir(join(root, '.git'));
  expect(await larkForkWorkspaceMode(root)).toBe('shared');
  execFileSync('git', ['init', '-q', root]);
  expect(await larkForkWorkspaceMode(root)).toBe('worktree');
  expect(await larkForkWorkspaceMode(root, 'shared')).toBe('shared');
});
it('an unreadable/missing directory must not silently choose shared', async () => {
  await expect(larkForkWorkspaceMode('/missing/dutydeck-fork-directory')).rejects.toThrow('未使用共享目录');
});
