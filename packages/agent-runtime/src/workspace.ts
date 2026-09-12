import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ConfigRepository, SessionWorkspace, WorkspaceMode } from '@dutydeck/shared';
import { now, RuntimeError } from '@dutydeck/shared';
import { minimalToolEnvironment } from './process-environment.js';

const runFile = promisify(execFile);
const WORKSPACE_KEY_PREFIX = 'runtime_workspace:';

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      env: { ...minimalToolEnvironment(), GIT_TERMINAL_PROMPT: '0' }
    });
    return stdout.trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeError('WORKSPACE_GIT_FAILED', detail, 422);
  }
}

async function canonical(path: string): Promise<string> {
  return realpath(path);
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
    try { return JSON.parse(raw) as SessionWorkspace; }
    catch { throw new RuntimeError('WORKSPACE_RECORD_INVALID', `Workspace record is invalid: ${sessionId}`, 500); }
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
}

function hasWorktreeIntent(record: SessionWorkspace): record is SessionWorkspace & Required<Pick<SessionWorkspace, 'repoRoot' | 'gitCommonDir' | 'relativeCwd' | 'baselineCommit' | 'branch'>> {
  return record.mode === 'worktree'
    && typeof record.repoRoot === 'string'
    && typeof record.gitCommonDir === 'string'
    && typeof record.relativeCwd === 'string'
    && typeof record.baselineCommit === 'string'
    && typeof record.branch === 'string';
}
