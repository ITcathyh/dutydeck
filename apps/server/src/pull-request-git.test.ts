import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCommit, diffTrees, originPushUrl, pushBranch, treeEntries } from './pull-request-git.js';
import { snapshotWorkingTree } from './turn-diff.js';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('/pr git in an agent-writable workspace', () => {
  it('builds and pushes without running workspace or local-remote hooks and repository-configured programs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-pr-git-'));
    dirs.push(root);
    const remote = join(root, 'remote.git'), cwd = join(root, 'work'), marker = join(root, 'ran');
    const program = join(root, 'program.sh');
    await writeFile(program, `#!/bin/sh\necho "$0 $*" >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await run('git', ['init', '-q', '-b', 'main', cwd]);
    const git = async (...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();
    await git('config', 'user.email', 'user@example.com'); await git('config', 'user.name', 'User');
    await writeFile(join(cwd, 'app.ts'), 'export const a = 1;\n');
    await git('add', '.'); await git('commit', '-qm', 'initial');
    await git('push', '-q', remote, 'main');
    await git('remote', 'add', 'origin', remote);
    await mkdir(join(cwd, '.git/hooks'), { recursive: true }); await mkdir(join(remote, 'hooks'), { recursive: true });
    for (const hook of ['pre-push', 'reference-transaction']) await writeFile(join(cwd, '.git/hooks', hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    await writeFile(join(remote, 'hooks/pre-receive'), `#!/bin/sh\necho pre-receive >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    for (const [key, value] of [['core.fsmonitor', program], ['core.sshCommand', program], ['credential.helper', `!${program}`], ['core.alternateRefsCommand', program]]) await git('config', key, value);

    const url = await originPushUrl(cwd);
    const blob = await git('hash-object', '-w', 'app.ts');
    const head = await git('rev-parse', 'HEAD');
    const commit = await buildCommit(cwd, head, [{ path: 'new.ts', sha: blob }], 'feat: add new');
    await pushBranch(cwd, url, commit, 'dutydeck/fix-login', 'main');

    expect((await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/dutydeck/fix-login'])).stdout.trim()).toBe(commit);
    expect(existsSync(marker)).toBe(false);
  });

  it('preserves gitlinks on add, update and delete alongside regular files and symlinks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-pr-gitlink-'));
    dirs.push(cwd);
    const git = async (...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'user@example.com'); await git('config', 'user.name', 'User');
    await git('commit', '-q', '--allow-empty', '-m', 'root');
    const root = await git('rev-parse', 'HEAD');

    const vendor = join(cwd, 'vendor');
    await mkdir(vendor);
    const subGit = async (...args: string[]) => (await run('git', ['-C', vendor, ...args])).stdout.trim();
    await subGit('init', '-q');
    await subGit('config', 'user.email', 'sub@example.com'); await subGit('config', 'user.name', 'Submodule');
    await writeFile(join(vendor, 'code.txt'), 'old\n');
    await subGit('add', '.'); await subGit('commit', '-qm', 'old submodule');
    const oldSha = await subGit('rev-parse', 'HEAD');
    await writeFile(join(cwd, '.gitmodules'), '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.test/vendor.git\n');
    await git('add', '.'); await git('commit', '-qm', 'add submodule');
    const base = await git('rev-parse', 'HEAD');

    const addedChanges = await diffTrees({ cwd }, root, base);
    const addedEntries = await treeEntries({ cwd }, base, addedChanges.map(change => change.path));
    expect(addedEntries.get('vendor')).toEqual({ mode: '160000', sha: oldSha });
    const addedCommit = await buildCommit(cwd, root, addedChanges.map(change => ({ path: change.path, ...addedEntries.get(change.path)! })), 'add gitlink');
    expect(await git('ls-tree', addedCommit, 'vendor')).toBe(`160000 commit ${oldSha}\tvendor`);

    const before = await snapshotWorkingTree(cwd, 30_000);
    await writeFile(join(vendor, 'code.txt'), 'new\n');
    await subGit('add', '.'); await subGit('commit', '-qm', 'new submodule');
    const newSha = await subGit('rev-parse', 'HEAD');
    await writeFile(join(cwd, 'normal.txt'), 'plain\n');
    await symlink('normal.txt', join(cwd, 'link.txt'));
    const after = await snapshotWorkingTree(cwd, 30_000);
    expect(before && after).toBeTruthy();
    const changes = await diffTrees({ cwd }, before!.tree, after!.tree);
    const entries = await treeEntries({ cwd }, after!.tree, changes.map(change => change.path));
    expect(entries.get('vendor')).toEqual({ mode: '160000', sha: newSha });
    expect(entries.get('normal.txt')).toMatchObject({ mode: '100644' });
    expect(entries.get('link.txt')).toMatchObject({ mode: '120000' });
    const contents = changes.map(change => ({ path: change.path, ...entries.get(change.path)! }));
    const updatedCommit = await buildCommit(cwd, base, contents, 'update gitlink');
    expect(await git('ls-tree', updatedCommit, 'vendor')).toBe(`160000 commit ${newSha}\tvendor`);
    expect(await git('ls-tree', updatedCommit, 'link.txt')).toMatch(/^120000 blob [0-9a-f]{40}\tlink\.txt$/);
    expect(await git('show', `${updatedCommit}:normal.txt`)).toBe('plain');
    expect(await git('show', `${updatedCommit}:link.txt`)).toBe('normal.txt');

    await rm(vendor, { recursive: true, force: true });
    const deleted = await snapshotWorkingTree(cwd, 30_000);
    const deletion = (await diffTrees({ cwd }, before!.tree, deleted!.tree)).find(change => change.path === 'vendor');
    expect(deletion).toMatchObject({ change: 'deleted' });
    const deletedEntries = await treeEntries({ cwd }, deleted!.tree, ['vendor']);
    expect(deletedEntries.has('vendor')).toBe(false);
    const deletedCommit = await buildCommit(cwd, base, [{ path: 'vendor' }], 'delete gitlink');
    expect(await git('ls-tree', deletedCommit, 'vendor')).toBe('');
  });
});
