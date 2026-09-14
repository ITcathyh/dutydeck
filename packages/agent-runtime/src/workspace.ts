import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ConfigRepository, SessionWorkspace, WorkspaceCleanupBlocker, WorkspaceMode } from '@dutydeck/shared';
import { now, RuntimeError } from '@dutydeck/shared';
import { minimalToolEnvironment } from './process-environment.js';

const runFile = promisify(execFile);
const WORKSPACE_KEY_PREFIX = 'runtime_workspace:';

async function git(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...minimalToolEnvironment(), GIT_TERMINAL_PROMPT: '0' }
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeError('WORKSPACE_GIT_FAILED', detail, 422);
  }
}

async function gitRaw(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...minimalToolEnvironment(), GIT_TERMINAL_PROMPT: '0' }
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeError('WORKSPACE_GIT_FAILED', detail, 422);
  }
}

async function canonical(path: string): Promise<string> {
  return realpath(path);
}

interface LinkedWorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  isMain: boolean;
}

async function getLinkedWorktrees(repoDir: string): Promise<LinkedWorktreeEntry[]> {
  const stdout = await git(repoDir, ['worktree', 'list', '--porcelain']);
  const lines = stdout.split('\n');
  const result: LinkedWorktreeEntry[] = [];
  let current: Partial<LinkedWorktreeEntry> = {};
  let isFirst = true;

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current.path && current.head) {
        result.push({
          path: await canonical(current.path).catch(() => current.path!),
          head: current.head,
          branch: current.branch,
          isMain: current.isMain ?? false
        });
      }
      current = {
        path: line.slice('worktree '.length).trim(),
        isMain: isFirst
      };
      isFirst = false;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.trim() === '') {
      if (current.path && current.head) {
        result.push({
          path: await canonical(current.path).catch(() => current.path!),
          head: current.head,
          branch: current.branch,
          isMain: current.isMain ?? false
        });
        current = {};
      }
    }
  }
  if (current.path && current.head) {
    result.push({
      path: await canonical(current.path).catch(() => current.path!),
      head: current.head,
      branch: current.branch,
      isMain: current.isMain ?? false
    });
  }
  return result;
}

function parseGitStatusZ(raw: string): {
  trackedFiles: string[];
  untrackedFiles: string[];
  ignoredFiles: string[];
  entries: Array<{ status: string; path: string }>;
} {
  const trackedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const ignoredFiles: string[] = [];
  const entries: Array<{ status: string; path: string }> = [];

  if (!raw) return { trackedFiles, untrackedFiles, ignoredFiles, entries };

  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const status = part.slice(0, 2);
    const path = part.slice(3);
    entries.push({ status, path });

    if (status === '??') {
      untrackedFiles.push(path);
    } else if (status === '!!') {
      ignoredFiles.push(path);
    } else {
      trackedFiles.push(path);
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      i++;
    }
  }
  return { trackedFiles, untrackedFiles, ignoredFiles, entries };
}

function workspaceKey(sessionId: string) { return WORKSPACE_KEY_PREFIX + sessionId; }

export class WorkspaceManager {
  readonly root: string;

  constructor(private readonly config: ConfigRepository, root?: string) {
    this.root = resolve(root ?? join(homedir(), '.dutydeck', 'workspaces'));
  }

  async get(sessionId: string): Promise<SessionWorkspace | undefined> {
    const raw = await this.config.get(workspaceKey(sessionId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as SessionWorkspace;
      return await this.tryRecoverCleaning(parsed);
    }
    catch (err) {
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError('WORKSPACE_RECORD_INVALID', `Workspace record is invalid: ${sessionId}`, 500);
    }
  }

  private async replace(record: SessionWorkspace, expected: SessionWorkspace | undefined): Promise<void> {
    const key = workspaceKey(record.sessionId);
    const expectedRaw = expected ? JSON.stringify(expected) : undefined;
    if (this.config.compareAndSet) {
      if (!await this.config.compareAndSet(key, expectedRaw, JSON.stringify(record))) {
        throw new RuntimeError('WORKSPACE_CONFLICT', 'Workspace preparation changed concurrently', 409);
      }
      return;
    }
    if (await this.config.get(key) !== expectedRaw) throw new RuntimeError('WORKSPACE_CONFLICT', 'Workspace preparation changed concurrently', 409);
    await this.config.set(key, JSON.stringify(record));
  }

  async tryRecoverCleaning(record: SessionWorkspace): Promise<SessionWorkspace> {
    if (record.state !== 'cleaning' || !hasWorktreeIntent(record)) return record;
    try {
      await stat(record.repoRoot);
      return record;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        return record;
      }
    }

    try {
      const sourceRepoRoot = await canonical(await git(record.sourceCwd, ['rev-parse', '--show-toplevel']));
      const common = await git(sourceRepoRoot, ['rev-parse', '--git-common-dir']);
      const actualCommon = await canonical(isAbsolute(common) ? common : join(sourceRepoRoot, common));
      if (actualCommon !== record.gitCommonDir) {
        return record;
      }
      const list = await getLinkedWorktrees(sourceRepoRoot);
      const canonicalTarget = await canonical(record.repoRoot).catch(() => record.repoRoot);
      const stillInWorktrees = list.some(item => item.path === canonicalTarget || item.path === record.repoRoot);
      if (stillInWorktrees) {
        return record;
      }
    } catch {
      return record;
    }

    const cleaned: SessionWorkspace = {
      ...record,
      revision: record.revision + 1,
      state: 'cleaned',
      cleanedAt: record.updatedAt,
      updatedAt: now(),
      error: undefined,
      cleanupError: undefined
    };
    await this.replace(cleaned, record);
    return cleaned;
  }

  async prepare(sessionId: string, sourceCwd: string, mode: WorkspaceMode): Promise<SessionWorkspace> {
    if (typeof sourceCwd !== 'string' || !sourceCwd.trim()) throw new RuntimeError('WORKSPACE_INVALID_SOURCE', 'Session cwd must be a non-empty string', 400);
    if (mode !== 'shared' && mode !== 'worktree') throw new RuntimeError('WORKSPACE_INVALID_MODE', 'Workspace mode must be shared or worktree', 400);
    const requestedSource = resolve(sourceCwd);
    const existing = await this.get(sessionId);
    let source: string;
    try { source = await canonical(requestedSource); }
    catch (error) {
      if (existing && (existing.mode !== mode || existing.sourceCwd !== requestedSource)) {
        throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', 'Workspace retry does not match its persisted source and mode', 409);
      }
      const message = `Session cwd is unavailable: ${requestedSource}`;
      const timestamp = now();
      const failed: SessionWorkspace = existing
        ? { ...existing, revision: existing.revision + 1, state: 'failed', updatedAt: timestamp, error: message }
        : { schemaVersion: 1, revision: 1, sessionId, mode, sourceCwd: requestedSource, cwd: requestedSource, state: 'failed', createdAt: timestamp, updatedAt: timestamp, error: message };
      await this.replace(failed, existing);
      throw new RuntimeError('WORKSPACE_INVALID_SOURCE', `${message}: ${error instanceof Error ? error.message : String(error)}`, 422);
    }
    if (existing && (existing.mode !== mode || existing.sourceCwd !== source)) {
      throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', 'Workspace retry does not match its persisted source and mode', 409);
    }
    if (existing?.state === 'ready') {
      await this.validate(existing);
      return existing;
    }
    const timestamp = now();
    let preparing: SessionWorkspace;
    if (existing?.state === 'preparing') preparing = existing;
    else {
      preparing = existing
        ? { ...existing, revision: existing.revision + 1, state: 'preparing', updatedAt: timestamp, error: undefined }
        : { schemaVersion: 1, revision: 1, sessionId, mode, sourceCwd: source, cwd: source, state: 'preparing', createdAt: timestamp, updatedAt: timestamp };
      await this.replace(preparing, existing);
    }

    try {
      if (mode === 'worktree' && !hasWorktreeIntent(preparing)) {
        const fixedIntent = await this.discoverWorktreeIntent(preparing);
        await this.replace(fixedIntent, preparing);
        preparing = fixedIntent;
      }
      const ready = mode === 'shared'
        ? await this.prepareShared(preparing)
        : await this.prepareWorktree(preparing);
      await this.replace(ready, preparing);
      return ready;
    } catch (error) {
      const failed: SessionWorkspace = {
        ...preparing,
        revision: preparing.revision + 1,
        state: 'failed',
        updatedAt: now(),
        error: error instanceof Error ? error.message : String(error)
      };
      try { await this.replace(failed, preparing); } catch { /* Preserve the preparation failure. */ }
      throw error;
    }
  }

  private async prepareShared(record: SessionWorkspace): Promise<SessionWorkspace> {
    const info = await stat(record.sourceCwd);
    if (!info.isDirectory()) throw new RuntimeError('WORKSPACE_INVALID_SOURCE', 'Session cwd must be a directory', 422);
    let repoRoot: string | undefined;
    let gitCommonDir: string | undefined;
    try {
      repoRoot = await canonical(await git(record.sourceCwd, ['rev-parse', '--show-toplevel']));
      const common = await git(repoRoot, ['rev-parse', '--git-common-dir']);
      gitCommonDir = await canonical(isAbsolute(common) ? common : join(repoRoot, common));
    } catch (error) {
      if (!(error instanceof RuntimeError && error.code === 'WORKSPACE_GIT_FAILED')) throw error;
    }
    return {
      ...record, revision: record.revision + 1, state: 'ready', cwd: record.sourceCwd,
      ...(repoRoot ? { repoRoot, relativeCwd: relative(repoRoot, record.sourceCwd), gitCommonDir } : {}),
      updatedAt: now(), error: undefined
    };
  }

  private async discoverWorktreeIntent(record: SessionWorkspace): Promise<SessionWorkspace> {
    const sourceRepoRoot = await canonical(await git(record.sourceCwd, ['rev-parse', '--show-toplevel']));
    const relativeCwd = relative(sourceRepoRoot, record.sourceCwd);
    if (relativeCwd.startsWith(`..${sep}`) || relativeCwd === '..' || isAbsolute(relativeCwd)) {
      throw new RuntimeError('WORKSPACE_INVALID_SOURCE', 'Session cwd is outside its Git repository', 422);
    }
    const baselineCommit = await git(sourceRepoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const common = await git(sourceRepoRoot, ['rev-parse', '--git-common-dir']);
    const gitCommonDir = await canonical(isAbsolute(common) ? common : join(sourceRepoRoot, common));
    const branch = `dutydeck/session/${record.sessionId}`;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = join(await canonical(this.root), record.sessionId);
    return {
      ...record, revision: record.revision + 1, cwd: relativeCwd ? join(root, relativeCwd) : root,
      repoRoot: root, relativeCwd, baselineCommit, branch, gitCommonDir, updatedAt: now()
    };
  }

  private async prepareWorktree(record: SessionWorkspace): Promise<SessionWorkspace> {
    if (!hasWorktreeIntent(record)) throw new RuntimeError('WORKSPACE_RECORD_INVALID', 'Managed workspace intent is incomplete', 500);
    const sourceRepoRoot = await canonical(await git(record.sourceCwd, ['rev-parse', '--show-toplevel']));
    const common = await git(sourceRepoRoot, ['rev-parse', '--git-common-dir']);
    const actualCommon = await canonical(isAbsolute(common) ? common : join(sourceRepoRoot, common));
    const actualSource = await canonical(record.relativeCwd ? join(sourceRepoRoot, record.relativeCwd) : sourceRepoRoot);
    if (actualCommon !== record.gitCommonDir || actualSource !== record.sourceCwd) {
      throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', 'Workspace source repository changed identity', 409);
    }
    await git(sourceRepoRoot, ['rev-parse', '--verify', `${record.baselineCommit}^{commit}`]);
    let rootExists = false;
    try {
      const info = await stat(record.repoRoot);
      if (!info.isDirectory()) throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', 'Managed workspace target is not a directory', 409);
      rootExists = true;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
    }
    if (rootExists && await git(record.repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']) !== record.baselineCommit) {
      throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', 'Recovered workspace moved away from its fixed baseline before preparation completed', 409);
    }
    if (!rootExists) {
      let branchCommit: string | undefined;
      try { branchCommit = await git(sourceRepoRoot, ['rev-parse', '--verify', `refs/heads/${record.branch}^{commit}`]); } catch { /* New branch. */ }
      if (branchCommit && branchCommit !== record.baselineCommit) {
        throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', `Existing workspace branch ${record.branch} has a different baseline`, 409);
      }
      await git(sourceRepoRoot, branchCommit
        ? ['worktree', 'add', record.repoRoot, record.branch]
        : ['worktree', 'add', '-b', record.branch, record.repoRoot, record.baselineCommit]);
    }
    const ready: SessionWorkspace = {
      ...record, revision: record.revision + 1, state: 'ready', updatedAt: now(), error: undefined
    };
    await this.validate(ready);
    return ready;
  }

  async validate(record: SessionWorkspace): Promise<void> {
    if (record.state === 'cleaned') return;
    let cwd: string;
    try {
      cwd = await canonical(record.cwd);
      const info = await stat(cwd);
      if (!info.isDirectory()) throw new Error('not a directory');
    } catch {
      throw new RuntimeError('WORKSPACE_UNAVAILABLE', `Persisted workspace is unavailable: ${record.cwd}`, 409);
    }
    if (cwd !== record.cwd) throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', 'Persisted workspace path changed identity', 409);
    if (record.mode === 'shared') return;
    if (!record.repoRoot || !record.gitCommonDir || !record.branch || !record.baselineCommit) {
      throw new RuntimeError('WORKSPACE_RECORD_INVALID', 'Managed workspace ownership metadata is incomplete', 500);
    }
    let actualRoot: string;
    let actualCommon: string;
    let actualBranch: string;
    try {
      actualRoot = await canonical(await git(cwd, ['rev-parse', '--show-toplevel']));
      const common = await git(cwd, ['rev-parse', '--git-common-dir']);
      actualCommon = await canonical(isAbsolute(common) ? common : join(actualRoot, common));
      actualBranch = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
    } catch {
      throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', 'Persisted workspace no longer belongs to this Session', 409);
    }
    if (actualRoot !== record.repoRoot || actualCommon !== record.gitCommonDir || actualBranch !== record.branch) {
      throw new RuntimeError('WORKSPACE_OWNERSHIP_MISMATCH', 'Persisted workspace no longer belongs to this Session', 409);
    }
  }

  async checkSafety(record: SessionWorkspace): Promise<{
    canClean: boolean;
    blockers: WorkspaceCleanupBlocker[];
    fingerprint: string;
    cleanedAt?: string;
  }> {
    const recovered = await this.tryRecoverCleaning(record);
    if (recovered.state === 'cleaned') {
      return {
        canClean: false,
        blockers: [],
        fingerprint: '',
        cleanedAt: recovered.cleanedAt
      };
    }
    const blockers: WorkspaceCleanupBlocker[] = [];
    if (recovered.mode !== 'worktree') {
      blockers.push({ code: 'SHARED_WORKSPACE', message: '共享工作目录不可清理' });
      return { canClean: false, blockers, fingerprint: '' };
    }
    if (!hasWorktreeIntent(recovered)) {
      blockers.push({ code: 'WORKSPACE_RECORD_INVALID', message: '工作区元数据不完整' });
      return { canClean: false, blockers, fingerprint: '' };
    }

    let canonicalRoot: string;
    let expectedRoot: string;
    try {
      canonicalRoot = await canonical(this.root);
      expectedRoot = join(canonicalRoot, recovered.sessionId);
    } catch (err) {
      blockers.push({ code: 'WORKSPACE_ROOT_UNAVAILABLE', message: '工作区根目录不可用', details: [err instanceof Error ? err.message : String(err)] });
      return { canClean: false, blockers, fingerprint: '' };
    }

    let repoRootCanonical: string | undefined;
    let dirExists = false;
    try {
      repoRootCanonical = await canonical(recovered.repoRoot);
      const info = await stat(repoRootCanonical);
      dirExists = info.isDirectory();
    } catch {}

    if (repoRootCanonical && repoRootCanonical !== expectedRoot) {
      blockers.push({ code: 'OWNERSHIP_MISMATCH', message: '工作区路径与此 Session 托管位置不符' });
    }

    if (!dirExists || !repoRootCanonical) {
      blockers.push({ code: 'DIRECTORY_MISSING', message: `工作目录不存在: ${recovered.repoRoot}` });
      return { canClean: false, blockers, fingerprint: '' };
    }
    const targetRoot = repoRootCanonical;

    // 检查是否为真实 linked worktree，不能是 main checkout，也不能注册身份错误
    let sourceRepoRoot: string;
    try {
      sourceRepoRoot = await canonical(await git(recovered.sourceCwd, ['rev-parse', '--show-toplevel']));
      const common = await git(sourceRepoRoot, ['rev-parse', '--git-common-dir']);
      const actualCommon = await canonical(isAbsolute(common) ? common : join(sourceRepoRoot, common));
      if (actualCommon !== recovered.gitCommonDir) {
        blockers.push({ code: 'SOURCE_REPO_MISMATCH', message: '工作区所属 Git 仓库与记录不符' });
      }
    } catch (err) {
      blockers.push({ code: 'SOURCE_GIT_UNAVAILABLE', message: '源 Git 仓库不可用', details: [err instanceof Error ? err.message : String(err)] });
      return { canClean: false, blockers, fingerprint: '' };
    }

    try {
      const list = await getLinkedWorktrees(sourceRepoRoot);
      const matched = list.find(item => item.path === repoRootCanonical);
      if (!matched) {
        blockers.push({ code: 'NOT_LINKED_WORKTREE', message: '该目录未在源仓库的 Git worktree 列表中注册' });
      } else if (matched.isMain) {
        blockers.push({ code: 'MAIN_WORKTREE_PROTECTED', message: '目标为主工作树，不可删除' });
      } else if (matched.branch !== recovered.branch) {
        blockers.push({ code: 'BRANCH_MISMATCH', message: `工作树分支与记录不符（实际为 ${matched.branch ?? 'DETACHED'}，预期为 ${recovered.branch}）` });
      }
    } catch (err) {
      blockers.push({ code: 'WORKTREE_LIST_FAILED', message: '读取 Git worktree 注册列表失败', details: [err instanceof Error ? err.message : String(err)] });
    }

    // 校验实际 worktree 的 top level 和 gitCommonDir
    try {
      const actualRoot = await canonical(await git(repoRootCanonical, ['rev-parse', '--show-toplevel']));
      const common = await git(repoRootCanonical, ['rev-parse', '--git-common-dir']);
      const actualCommon = await canonical(isAbsolute(common) ? common : join(actualRoot, common));
      const actualBranch = await git(repoRootCanonical, ['symbolic-ref', '--short', 'HEAD']);
      if (actualRoot !== repoRootCanonical || actualCommon !== recovered.gitCommonDir || actualBranch !== recovered.branch) {
        blockers.push({ code: 'WORKTREE_IDENTITY_MISMATCH', message: '工作目录 Git 身份校验失败' });
      }
    } catch (err) {
      blockers.push({ code: 'WORKTREE_GIT_FAILED', message: '工作目录 Git 信息读取失败', details: [err instanceof Error ? err.message : String(err)] });
    }

    // 子模块检查：仅拒绝已初始化（首字符为空格/+）或处于冲突状态（U）的子模块；
    // 未初始化（首字符为 -）的子模块不会在 worktree remove 时产生额外删除。
    try {
      const subOut = await git(repoRootCanonical, ['submodule', 'status']);
      const initialized = subOut.split('\n')
        .map(line => line.trimEnd())
        .filter(line => line.length > 0 && !line.startsWith('-'));
      if (initialized.length > 0) {
        blockers.push({ code: 'SUBMODULE_PRESENT', message: '工作区包含初始化的子模块，不支持自动清理', details: initialized.map(line => line.replace(/^[ +U]+/, '').split(' ')[1] ?? line).slice(0, 20) });
      }
    } catch (err) {
      blockers.push({
        code: 'SUBMODULE_CHECK_FAILED',
        message: '读取子模块状态失败',
        details: [err instanceof Error ? err.message : String(err)]
      });
    }

    // Tracked / untracked / ignored 检查
    let rawStatus = '';
    try {
      rawStatus = await gitRaw(repoRootCanonical, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all']);
      const { trackedFiles, untrackedFiles, ignoredFiles } = parseGitStatusZ(rawStatus);
      if (trackedFiles.length) {
        blockers.push({ code: 'DIRTY_TRACKED', message: '存在未提交的代码改动', details: trackedFiles.slice(0, 20) });
      }
      if (untrackedFiles.length) {
        blockers.push({ code: 'UNTRACKED_FILES', message: '存在未跟踪的文件', details: untrackedFiles.slice(0, 20) });
      }
      if (ignoredFiles.length) {
        blockers.push({ code: 'IGNORED_FILES', message: '存在被忽略的文件（移除工作树将同时删除这些文件）', details: ignoredFiles.slice(0, 20) });
      }
    } catch (err) {
      blockers.push({ code: 'STATUS_CHECK_FAILED', message: '检查工作目录改动状态失败', details: [err instanceof Error ? err.message : String(err)] });
    }

    // 检查 Git index 隐藏标记（assume-unchanged 和 skip-worktree）
    // 普通 git status 会忽略带有此类标记的文件修改，若不检查将导致未提交的隐藏内容被误删
    let rawLsFiles = '';
    try {
      rawLsFiles = await gitRaw(repoRootCanonical, ['ls-files', '-v', '-z']);
      const records = rawLsFiles.split('\0');
      const assumeUnchangedFiles: string[] = [];
      const skipWorktreeFiles: string[] = [];
      for (const record of records) {
        if (record.length < 3 || record[1] !== ' ') continue;
        const tag = record[0];
        if (!tag) continue;
        const filePath = record.slice(2);
        if (tag === 'S' || tag === 's') {
          skipWorktreeFiles.push(filePath);
        } else if (tag >= 'a' && tag <= 'z') {
          assumeUnchangedFiles.push(filePath);
        }
      }
      if (assumeUnchangedFiles.length > 0) {
        blockers.push({
          code: 'ASSUME_UNCHANGED_FILES',
          message: '存在 assume-unchanged 标记的隐藏索引文件，不可清理',
          details: assumeUnchangedFiles.slice(0, 20)
        });
      }
      if (skipWorktreeFiles.length > 0) {
        blockers.push({
          code: 'SKIP_WORKTREE_FILES',
          message: '存在 skip-worktree 标记的隐藏索引文件，不可清理',
          details: skipWorktreeFiles.slice(0, 20)
        });
      }
    } catch (err) {
      blockers.push({
        code: 'INDEX_CHECK_FAILED',
        message: '读取 Git 索引隐藏标记失败',
        details: [err instanceof Error ? err.message : String(err)]
      });
    }

    // 本地新增提交检查（未合并到 baseline 且未在本地 remote refs 可达）
    let currentHead = '';
    try {
      currentHead = await git(repoRootCanonical, ['rev-parse', 'HEAD']);
      const revList = await git(repoRootCanonical, ['rev-list', 'HEAD', '--not', recovered.baselineCommit, '--remotes']);
      if (revList.trim()) {
        const logOut = await git(repoRootCanonical, ['log', '--oneline', '--max-count=20', 'HEAD', '--not', recovered.baselineCommit, '--remotes']);
        const unpushedCommits = logOut.trim().split('\n').filter(Boolean);
        blockers.push({ code: 'UNPUSHED_COMMITS', message: '存在未保存到基线或本地远端分支的新增提交', details: unpushedCommits });
      }
    } catch (err) {
      blockers.push({ code: 'REV_LIST_FAILED', message: '检查新增提交失败', details: [err instanceof Error ? err.message : String(err)] });
    }

    // Fingerprint 计算
    const fpHash = createHash('sha256')
      .update(recovered.sessionId)
      .update('\0')
      .update(String(recovered.revision))
      .update('\0')
      .update(currentHead)
      .update('\0')
      .update(rawStatus)
      .update('\0')
      .update(rawLsFiles)
      .digest('hex');
    const fingerprint = `fp_${fpHash}`;

    return {
      canClean: blockers.length === 0,
      blockers,
      fingerprint,
      cleanedAt: undefined
    };
  }

  async removeWorktree(record: SessionWorkspace, expectedRevision: number, fingerprint: string): Promise<SessionWorkspace> {
    const recovered = await this.tryRecoverCleaning(record);
    if (recovered.state === 'cleaned') return recovered;
    if (!hasWorktreeIntent(recovered)) {
      throw new RuntimeError('WORKSPACE_RECORD_INVALID', 'Managed workspace intent is incomplete', 500);
    }
    if (recovered.revision !== expectedRevision) {
      throw new RuntimeError('WORKSPACE_CONFLICT', '工作区版本已发生变动，请重新检查', 409);
    }
    const safety = await this.checkSafety(recovered);
    if (safety.cleanedAt) return recovered;
    if (!safety.canClean) {
      const first = safety.blockers[0];
      throw new RuntimeError(first?.code ?? 'CANNOT_CLEAN', first?.message ?? '工作目录当前无法安全清理', 409);
    }
    if (safety.fingerprint !== fingerprint) {
      throw new RuntimeError('WORKSPACE_FINGERPRINT_MISMATCH', '工作目录状态已变化，请重新检查', 409);
    }

    // 记录清理意图（cleaning 状态 CAS 写库）
    const cleaning: SessionWorkspace = {
      ...recovered,
      revision: recovered.revision + 1,
      state: 'cleaning',
      updatedAt: now(),
      error: undefined,
      cleanupError: undefined
    };
    await this.replace(cleaning, recovered);

    // 执行 Git 删除：绝对不传 --force，在 sourceCwd 执行
    try {
      await git(recovered.sourceCwd, ['worktree', 'remove', recovered.repoRoot]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: SessionWorkspace = {
        ...cleaning,
        revision: cleaning.revision + 1,
        state: recovered.state,
        updatedAt: now(),
        cleanupError: message
      };
      try { await this.replace(failed, cleaning); } catch {}
      throw new RuntimeError('WORKTREE_REMOVE_FAILED', `Git worktree remove failed: ${message}`, 422);
    }

    // 状态更新为 cleaned
    const timestamp = now();
    const cleaned: SessionWorkspace = {
      ...cleaning,
      revision: cleaning.revision + 1,
      state: 'cleaned',
      cleanedAt: timestamp,
      updatedAt: timestamp,
      error: undefined,
      cleanupError: undefined
    };
    await this.replace(cleaned, cleaning);
    return cleaned;
  }
}

function hasWorktreeIntent(record: SessionWorkspace): record is SessionWorkspace & Required<Pick<SessionWorkspace, 'repoRoot' | 'gitCommonDir' | 'relativeCwd' | 'baselineCommit' | 'branch'>> {
  return record.mode === 'worktree'
    && typeof record.repoRoot === 'string'
    && typeof record.gitCommonDir === 'string'
    && typeof record.relativeCwd === 'string'
    && typeof record.baselineCommit === 'string'
    && typeof record.branch === 'string';
}
