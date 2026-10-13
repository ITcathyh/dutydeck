import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createTurnDiffObserver, listTurnDiffRecords, readTurnDiff, readTurnDiffRecord, snapshotWorkingTree } from './turn-diff.js';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'turn-diff-'));
  dirs.push(dir);
  const git = (...args: string[]) => run('git', args, { cwd: dir });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(join(dir, '.gitignore'), 'ignored.log\n');
  await writeFile(join(dir, 'keep.txt'), 'keep\n');
  await writeFile(join(dir, 'edit.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(dir, 'gone.txt'), 'bye\n');
  await writeFile(join(dir, 'old-name.txt'), 'a stable body that should be detected as a rename\nline 2\nline 3\n');
  await writeFile(join(dir, 'dirty.txt'), 'clean\n');
  await git('add', '.'); await git('commit', '-m', 'init');
  return { dir, git };
}

function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    async get(key: string) { return values.get(key); },
    async set(key: string, value: string) { values.set(key, value); },
    async list(prefix: string) { return [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })); }
  };
}

describe('turn diff snapshots', () => {
  it('contains only this turn: new untracked files, deletions and renames, not what was already dirty before it started', async () => {
    const { dir, git } = await repo();
    // 开始前就有的未提交改动与未跟踪文件。
    await writeFile(join(dir, 'dirty.txt'), 'dirty before the turn\n');
    await writeFile(join(dir, 'scratch.txt'), 'untracked before the turn\n');
    const indexBefore = await readFile(join(dir, '.git', 'index'));
    const before = await snapshotWorkingTree(dir);
    expect(before).toBeDefined();
    // 快照不碰真实 index 和工作区。
    expect(await readFile(join(dir, '.git', 'index'))).toEqual(indexBefore);
    expect((await git('status', '--porcelain')).stdout).toContain('?? scratch.txt');

    await writeFile(join(dir, 'edit.txt'), 'one\n2\nthree\nfour\n');
    await unlink(join(dir, 'gone.txt'));
    await rename(join(dir, 'old-name.txt'), join(dir, 'new-name.txt'));
    await writeFile(join(dir, 'added.txt'), 'brand new\n');
    await writeFile(join(dir, 'ignored.log'), 'ignored\n');
    await mkdir(join(dir, '.dutydeck'), { recursive: true });
    await writeFile(join(dir, '.dutydeck', 'state.json'), '{}');
    const after = await snapshotWorkingTree(dir);
    const diff = await readTurnDiff(before!.gitDir, before!.tree, after!.tree);

    expect(diff.files.map(file => [file.status, file.oldPath ?? '', file.path])).toEqual([
      ['added', '', 'added.txt'],
      ['modified', '', 'edit.txt'],
      ['deleted', '', 'gone.txt'],
      ['renamed', 'old-name.txt', 'new-name.txt']
    ]);
    expect(diff.summary).toEqual({ files: 4, additions: 3, deletions: 2 });
    expect(diff.truncated).toBe(false);
    expect(diff.files[1]!.hunks[0]!.lines).toEqual([
      { kind: 'context', oldLine: 1, newLine: 1, text: 'one' },
      { kind: 'del', oldLine: 2, text: 'two' },
      { kind: 'add', newLine: 2, text: '2' },
      { kind: 'context', oldLine: 3, newLine: 3, text: 'three' },
      { kind: 'add', newLine: 4, text: 'four' }
    ]);
  });

  it('counts a commit made during the turn and only the new part of a file that was already dirty', async () => {
    const { dir, git } = await repo();
    await writeFile(join(dir, 'dirty.txt'), 'clean\nuser line\n');
    const before = await snapshotWorkingTree(dir);
    await writeFile(join(dir, 'dirty.txt'), 'clean\nuser line\nagent line\n');
    await writeFile(join(dir, 'keep.txt'), 'keep\nchanged and committed\n');
    await git('commit', '-am', 'agent commit');
    const after = await snapshotWorkingTree(dir);
    const diff = await readTurnDiff(before!.gitDir, before!.tree, after!.tree);
    expect(diff.files.map(file => file.path)).toEqual(['dirty.txt', 'keep.txt']);
    expect(diff.files[0]!.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind !== 'context')).toEqual([{ kind: 'add', newLine: 3, text: 'agent line' }]);
  });

  it('sees a same-size edit made in the same second as the last index write', async () => {
    const { dir, git } = await repo();
    await git('config', 'core.checkStat', 'minimal');
    const second = new Date('2026-01-01T00:00:00Z');
    await utimes(join(dir, 'keep.txt'), second, second);
    await git('update-index', '--refresh');
    await writeFile(join(dir, 'keep.txt'), 'KEEP\n');
    await utimes(join(dir, 'keep.txt'), second, second);
    await utimes(join(dir, '.git', 'index'), second, second);
    const snapshot = await snapshotWorkingTree(dir);
    expect(snapshot!.tree).not.toBe((await git('rev-parse', 'HEAD^{tree}')).stdout.trim());
  });

  it('gives no snapshot outside git and when the time limit is exceeded, without throwing', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'turn-diff-plain-'));
    dirs.push(plain);
    expect(await snapshotWorkingTree(plain)).toBeUndefined();
    expect(await snapshotWorkingTree(join(plain, 'missing'))).toBeUndefined();
    const { dir } = await repo();
    const started = Date.now();
    expect(await snapshotWorkingTree(dir, 1)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);

    const store = memoryStore();
    const observe = createTurnDiffObserver(store);
    await observe({ id: 'session_1', cwd: plain }, 'task_1', 'start');
    await observe({ id: 'session_1', cwd: plain }, 'task_1', 'end');
    expect(store.values.size).toBe(0);
  });

  it('shows binary and oversized files as placeholders and cuts the page at the total limit', async () => {
    const { dir } = await repo();
    const before = await snapshotWorkingTree(dir);
    await writeFile(join(dir, 'a-image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await writeFile(join(dir, 'b-big.txt'), 'x'.repeat(4_000) + '\n');
    await writeFile(join(dir, 'c-small.txt'), 'small\n');
    await writeFile(join(dir, 'd-later.txt'), 'y\n'.repeat(3_000));
    const after = await snapshotWorkingTree(dir);
    const diff = await readTurnDiff(before!.gitDir, before!.tree, after!.tree, { file: 2_000, total: 6_000 });
    expect(diff.files.map(file => [file.path, file.placeholder ?? 'shown'])).toEqual([
      ['a-image.bin', 'binary'], ['b-big.txt', 'too_large'], ['c-small.txt', 'shown'], ['d-later.txt', 'omitted']
    ]);
    expect(diff.truncated).toBe(true);
    expect(diff.summary.files).toBe(4);
  });

  it('records the start tree and the end summary for the turn and lists turns that changed something', async () => {
    const { dir } = await repo();
    const store = memoryStore();
    const observe = createTurnDiffObserver(store, { now: () => new Date('2026-10-13T00:00:00Z') });
    await observe({ id: 'session_1', cwd: dir }, 'task_1', 'start');
    await writeFile(join(dir, 'added.txt'), 'one\ntwo\n');
    await observe({ id: 'session_1', cwd: dir }, 'task_1', 'end');
    await observe({ id: 'session_1', cwd: dir }, 'task_2', 'start');
    await observe({ id: 'session_1', cwd: dir }, 'task_2', 'end');
    // 没有 start 的 end（重启后接上的一轮）不记。
    await observe({ id: 'session_1', cwd: dir }, 'task_3', 'end');
    expect(await readTurnDiffRecord(store, 'session_1', 'task_1')).toMatchObject({ summary: { files: 1, additions: 2, deletions: 0 }, finishedAt: '2026-10-13T00:00:00.000Z' });
    expect(await readTurnDiffRecord(store, 'session_1', 'task_2')).toMatchObject({ summary: { files: 0, additions: 0, deletions: 0 } });
    expect(await readTurnDiffRecord(store, 'session_1', 'task_3')).toBeUndefined();
    expect((await listTurnDiffRecords(store, 'session_1')).map(record => record.taskId)).toEqual(['task_1']);
  });
});
