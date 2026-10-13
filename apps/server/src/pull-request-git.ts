import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeError } from '@dutydeck/shared';

/**
 * `/pr` 用到的 git 操作。全部不动用户的检出：不切分支、不改 index、不写工作区、不建本地分支，
 * 提交用临时 index + `git commit-tree` 生成，推送用 `git push origin <提交>:refs/heads/dutydeck/...`。
 * 推送用本机的 git 凭据；错误信息去掉 URL 里的账号口令后才往外给。
 */

/** 仓库位置：工作区目录，或者只有对象库（每轮改动快照记的是公共 git 目录）。 */
export type GitRepo = { cwd: string } | { gitDir: string };
export type TreeEntry = { mode: string; sha: string };
export type TreeChange = { path: string; change: 'added' | 'modified' | 'deleted'; additions: number; deletions: number };
/** PR 里一个路径的内容；没有 sha 表示删除。 */
export type PathContent = { path: string; mode?: string; sha?: string };

const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
export const PR_BRANCH_PREFIX = 'dutydeck/';

/** git 输出里可能带远端 URL 中的账号口令或令牌参数，统一去掉，并压成一行。 */
export function redactGitOutput(text: string) {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1***@')
    .replace(/((?:access_)?token=|Bearer\s+|Authorization:\s*\S+\s+)[^\s&]+/gi, '$1***')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function git(repo: GitRepo, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): Promise<string> {
  const prefix = 'cwd' in repo ? ['-C', repo.cwd] : ['--git-dir', repo.gitDir];
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...prefix, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env },
      timeout: options.timeout ?? GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL'
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      reject(new RuntimeError('PR_GIT_FAILED', `git ${args[0]} 失败：${redactGitOutput(String(stderr || error.message))}`, 500));
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

const diffArgs = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];

/** 两棵树（或提交）之间改了哪些路径；改名按删除加新增算，逐个路径判断归属。 */
export async function diffTrees(repo: GitRepo, before: string, after: string): Promise<TreeChange[]> {
  const [numstat, status] = await Promise.all([
    git(repo, [...diffArgs, '--numstat', '-z', before, after]),
    git(repo, [...diffArgs, '--name-status', '-z', before, after])
  ]);
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const row of numstat.split('\0')) {
    const [added, deleted, path] = row.split('\t');
    if (path) counts.set(path, { additions: Number(added) || 0, deletions: Number(deleted) || 0 });
  }
  const parts = status.split('\0');
  const changes: TreeChange[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const code = parts[index];
    const path = parts[index + 1];
    if (!code || !path) continue;
    changes.push({ path, change: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', ...(counts.get(path) ?? { additions: 0, deletions: 0 }) });
  }
  return changes;
}

/** 树里这些路径的模式和 blob；不在树里的路径不出现在结果里。 */
export async function treeEntries(repo: GitRepo, tree: string, paths: string[]): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  for (let start = 0; start < paths.length; start += 200) {
    const output = await git(repo, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', tree, '--', ...paths.slice(start, start + 200)]);
    for (const row of output.split('\0')) {
      const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/s.exec(row);
      if (match) entries.set(match[3]!, { mode: match[1]!, sha: match[2]! });
    }
  }
  return entries;
}

export const sameEntry = (left?: TreeEntry, right?: TreeEntry) => (!left && !right) || Boolean(left && right && left.sha === right.sha && left.mode === right.mode);

/**
 * 在 parent 之上换掉 contents 里的路径，生成新提交。只用临时 index，不碰用户的 index、检出和分支。
 * 内容和 parent 相同时直接返回 parent。
 */
export async function buildCommit(cwd: string, parent: string, contents: PathContent[], message: string): Promise<string> {
  if (!contents.length) return parent;
  const scratch = await mkdtemp(join(tmpdir(), 'dutydeck-pr-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    const repo = { cwd };
    await git(repo, ['read-tree', parent], { env });
    const zero = '0'.repeat(parent.length);
    const input = contents.map(item => item.sha ? `${item.mode ?? '100644'} ${item.sha}\t${item.path}\0` : `0 ${zero}\t${item.path}\0`).join('');
    await git(repo, ['update-index', '-z', '--index-info'], { env, input });
    const tree = (await git(repo, ['write-tree'], { env })).trim();
    if (tree === (await git(repo, ['rev-parse', `${parent}^{tree}`])).trim()) return parent;
    const name = (await git(repo, ['config', 'user.name']).catch(() => '')).trim();
    const email = (await git(repo, ['config', 'user.email']).catch(() => '')).trim();
    const identity = name && email ? {} : { GIT_AUTHOR_NAME: 'DutyDeck', GIT_AUTHOR_EMAIL: 'dutydeck@localhost', GIT_COMMITTER_NAME: 'DutyDeck', GIT_COMMITTER_EMAIL: 'dutydeck@localhost' };
    return (await git(repo, ['commit-tree', tree, '-p', parent, '-F', '-'], { env: identity, input: message })).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** origin 的默认分支：先看本地记录的 origin/HEAD，没有再问远端。 */
export async function defaultBranch(cwd: string): Promise<string | undefined> {
  const local = await git({ cwd }, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  if (local.trim().startsWith('origin/')) return local.trim().slice('origin/'.length);
  const remote = await git({ cwd }, ['ls-remote', '--symref', 'origin', 'HEAD'], { timeout: PUSH_TIMEOUT_MS }).catch(() => '');
  return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote)?.[1];
}

/** 确认清单最多列出的本地提交数；超过就不开 PR，确认的内容必须和推送的一致。 */
export const LOCAL_COMMIT_LIMIT = 50;

/** 本地还没进目标分支的提交；没有 origin/<目标> 跟踪分支时无法确认。 */
export async function localCommits(cwd: string, target: string): Promise<{ commits: Array<{ sha: string; subject: string }>; unverified: boolean }> {
  const tracking = await git({ cwd }, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`]).catch(() => '');
  if (!tracking.trim()) return { commits: [], unverified: true };
  const range = `refs/remotes/origin/${target}..HEAD`;
  const count = Number((await git({ cwd }, ['rev-list', '--count', range])).trim());
  if (count > LOCAL_COMMIT_LIMIT) {
    throw new RuntimeError('PR_TOO_MANY_COMMITS', `本地有 ${count} 个提交还不在 ${target} 上，超过 ${LOCAL_COMMIT_LIMIT} 个，确认清单列不全，不能开 PR。请把它们整理成少量提交后再试。`, 409);
  }
  const output = await git({ cwd }, ['log', '--format=%H%x1f%s', range]);
  return { commits: output.split('\n').filter(Boolean).map(line => { const [sha, subject] = line.split('\x1f'); return { sha: sha!, subject: (subject ?? '').slice(0, 200) }; }), unverified: false };
}

export async function remoteBranchSha(cwd: string, branch: string): Promise<string | undefined> {
  const output = await git({ cwd }, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { timeout: PUSH_TIMEOUT_MS });
  return /^([0-9a-f]{40,64})\s/.exec(output)?.[1];
}

/** 只推 `dutydeck/` 分支，且不能是目标分支。 */
export function assertPushTarget(branch: string, target: string) {
  if (!/^dutydeck\/[a-z0-9][a-z0-9-]{0,63}$/.test(branch) || branch === target) {
    throw new RuntimeError('PR_BRANCH_REFUSED', `拒绝推送到 ${branch}：只能推送新建的 ${PR_BRANCH_PREFIX} 分支`, 409);
  }
}

/** 普通推送（不带 --force，refspec 不带 +）：新分支，或在已推送的提交上快进。 */
export async function pushBranch(cwd: string, commit: string, branch: string, target: string) {
  assertPushTarget(branch, target);
  await git({ cwd }, ['push', '--porcelain', 'origin', `${commit}:refs/heads/${branch}`], { timeout: PUSH_TIMEOUT_MS });
}
