import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';
import { DutydeckRuntime, type RuntimeOptions } from './index.js';
import { WorkspaceManager } from './workspace.js';

const agent: AgentConfig = {
  id: 'mock',
  name: 'Mock',
  command: process.execPath,
  args: [],
  protocol: 'acp',
  cwd: '/tmp',
  env: {},
  permissionMode: 'ask',
  timeout: 10,
  capabilities: { pause: false, resume: true },
  builtin: false
};

const cleanup: string[] = [];
const runtimes: DutydeckRuntime[] = [];
const repositories: ReturnType<typeof createRepositories>[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const repos of repositories.splice(0)) repos.close();
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporary(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function repository() {
  const root = temporary('dutydeck-clean-git-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Dutydeck Test');
  writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}

function driverFactory(sent: string[] = []): DriverFactory {
  return (_agent, _protocol, emit) => ({
    start: vi.fn(async () => {}),
    send: vi.fn(async prompt => {
      sent.push(prompt);
      emit({ type: 'text', data: { text: 'done' } });
    }),
    interrupt: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  });
}

function open(database: string, options: RuntimeOptions = {}, sent: string[] = []) {
  const repos = createRepositories(database);
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: driverFactory(sent),
    driverIdleTimeoutMs: 0,
    ...options
  });
  repositories.push(repos);
  runtimes.push(runtime);
  return { repos, runtime };
}

describe('managed workspace cleanup', () => {
  it('archives session while keeping worktree intact by default', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = await h.runtime.getWorkspace(session.id);
    expect(workspace?.state).toBe('ready');
    expect(existsSync(workspace!.cwd)).toBe(true);

    await h.runtime.archive(session.id);
    const archived = await h.runtime.getSession(session.id);
    expect(archived?.archivedAt).toBeDefined();

    // 默认归档必须保留目录
    expect(existsSync(workspace!.cwd)).toBe(true);
    const retained = await h.runtime.getWorkspace(session.id);
    expect(retained?.state).toBe('ready');
  });

  it('safely cleans a clean baseline worktree without deleting the branch, source, or task history', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await h.runtime.archive(session.id);

    const workspace = (await h.runtime.getWorkspace(session.id))!;
    const worktreeDir = workspace.repoRoot!;
    const branchName = workspace.branch!;
    expect(existsSync(worktreeDir)).toBe(true);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.branch).toBe(branchName);
    expect(preview.path).toBe(worktreeDir);
    expect(preview.fingerprint).toMatch(/^fp_[a-f0-9]{64}$/);

    const result = await h.runtime.cleanWorkspace(session.id, preview.fingerprint);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe(session.id);
    expect(result.path).toBe(worktreeDir);
    expect(result.cleanedAt).toBeDefined();

    // 目录确实已被移除
    expect(existsSync(worktreeDir)).toBe(false);

    // 源仓库与分支不受影响
    expect(existsSync(join(source, 'tracked.txt'))).toBe(true);
    expect(git(source, 'rev-parse', '--verify', `refs/heads/${branchName}^{commit}`)).toBe(workspace.baselineCommit);

    // 历史依然可读
    const cleanedWorkspace = await h.runtime.getWorkspace(session.id);
    expect(cleanedWorkspace?.state).toBe('cleaned');
    expect(cleanedWorkspace?.cleanedAt).toBe(result.cleanedAt);
  });

  it('rejects cleanup if tasks wrote untracked security policy files without white-listing', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await h.runtime.send(session.id, 'prompt causing security file');
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers.some(b => b.code === 'UNTRACKED_FILES' && b.details?.some(d => d.includes('.dutydeck')))).toBe(true);
  });

  it('rejects cleanup for unarchived sessions', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await expect(h.runtime.getWorkspaceCleanupPreview(session.id)).rejects.toMatchObject({
      code: 'SESSION_NOT_ARCHIVED',
      statusCode: 409
    });
    await expect(h.runtime.cleanWorkspace(session.id, 'fp_invalid')).rejects.toMatchObject({
      code: 'SESSION_NOT_ARCHIVED',
      statusCode: 409
    });
  });

  it('rejects cleanup for shared workspace mode', async () => {
    const source = repository();
    const h = open(':memory:');
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'shared' });
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({ code: 'SHARED_WORKSPACE' })]);

    await expect(h.runtime.cleanWorkspace(session.id, preview.fingerprint)).rejects.toMatchObject({
      code: 'CANNOT_CLEAN_SHARED',
      statusCode: 409
    });
  });

  it('rejects cleanup when tracked files are dirty', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await h.runtime.getWorkspace(session.id))!;
    writeFileSync(join(workspace.cwd, 'tracked.txt'), 'modified content\n');
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({ code: 'DIRTY_TRACKED', details: ['tracked.txt'] })]);

    await expect(h.runtime.cleanWorkspace(session.id, preview.fingerprint)).rejects.toMatchObject({
      code: 'DIRTY_TRACKED',
      statusCode: 409
    });
  });

  it('rejects cleanup when untracked files exist', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await h.runtime.getWorkspace(session.id))!;
    writeFileSync(join(workspace.cwd, 'new_file.txt'), 'scratch\n');
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({ code: 'UNTRACKED_FILES', details: ['new_file.txt'] })]);
  });

  it('rejects cleanup when ignored files exist, including user files under .dutydeck', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await h.runtime.getWorkspace(session.id))!;

    // 创建 .gitignore 忽略 .dutydeck/
    writeFileSync(join(workspace.cwd, '.gitignore'), '.dutydeck/\n*.log\n');
    git(workspace.cwd, 'add', '.gitignore');
    git(workspace.cwd, 'commit', '-qm', 'add gitignore');

    // 在 .dutydeck/ 下放入用户备份文件
    mkdirSync(join(workspace.cwd, '.dutydeck'), { recursive: true });
    writeFileSync(join(workspace.cwd, '.dutydeck', 'user-backup.tar'), 'important data');
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    // 包含 ignored files 或 unpushed commit
    expect(preview.blockers.some(b => b.code === 'IGNORED_FILES' || b.code === 'UNPUSHED_COMMITS')).toBe(true);
    const ignoredBlocker = preview.blockers.find(b => b.code === 'IGNORED_FILES');
    expect(ignoredBlocker?.details).toContain('.dutydeck/');
  });

  it('rejects cleanup when local commits are not pushed or in baseline', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await h.runtime.getWorkspace(session.id))!;
    writeFileSync(join(workspace.cwd, 'commit_file.txt'), 'committed\n');
    git(workspace.cwd, 'add', '.');
    git(workspace.cwd, 'commit', '-qm', 'local unpushed commit');
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers.some(b => b.code === 'UNPUSHED_COMMITS')).toBe(true);
    const blocker = preview.blockers.find(b => b.code === 'UNPUSHED_COMMITS');
    expect(blocker?.details?.[0]).toContain('local unpushed commit');
  });

  it('rejects cleanup when initialized submodules exist', async () => {
    const source = repository();
    const child = repository();
    git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub');
    git(source, 'commit', '-qam', 'add sub');

    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await h.runtime.getWorkspace(session.id))!;
    // 初始化子模块
    git(workspace.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers.some(b => b.code === 'SUBMODULE_PRESENT')).toBe(true);
  });

  it('rejects cleanup and keeps submodule content when submodule status cannot be confirmed', async () => {
    const source = repository();
    const child = repository();
    // 基线先包含子模块配置，使 worktree 分支继承 gitlink
    git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub');
    git(source, 'commit', '-qam', 'add sub');

    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await h.runtime.getWorkspace(session.id))!;
    // 初始化子模块，目录内存在唯一内容
    git(workspace.cwd, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    const submoduleContent = join(workspace.cwd, 'sub', 'tracked.txt');
    expect(existsSync(submoduleContent)).toBe(true);

    // 在 worktree HEAD 中删除 .gitmodules 配置但保留 gitlink，令 git submodule status 报错
    writeFileSync(join(workspace.cwd, '.gitmodules'), '');
    git(workspace.cwd, 'add', '.gitmodules');
    git(workspace.cwd, 'commit', '-qm', 'remove module config');

    // 以本地 remote ref 保存该 HEAD，排除未推送提交 blocker，让子模块检查成为唯一不确定项
    const head = git(workspace.cwd, 'rev-parse', 'HEAD');
    git(workspace.cwd, 'update-ref', 'refs/remotes/review/module', head);

    // 先确认复现前提：git submodule status 确实失败
    let subStatusFailed = false;
    try {
      git(workspace.cwd, 'submodule', 'status');
    } catch {
      subStatusFailed = true;
    }
    expect(subStatusFailed).toBe(true);

    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers.some(b => b.code === 'SUBMODULE_CHECK_FAILED')).toBe(true);

    await expect(h.runtime.cleanWorkspace(session.id, preview.fingerprint)).rejects.toMatchObject({
      code: 'SUBMODULE_CHECK_FAILED',
      statusCode: 409
    });

    // 拒绝后子模块内容必须保留，未被物理删除
    expect(existsSync(submoduleContent)).toBe(true);
    expect(existsSync(workspace.cwd)).toBe(true);
  });

  it('rejects cleanup if identity or registration is mismatched', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await h.runtime.archive(session.id);

    const manager = new WorkspaceManager(h.repos.config, workspaceRoot);
    const record = (await manager.get(session.id))!;
    // 伪造另外一个不匹配的分支
    const altered = { ...record, branch: 'dutydeck/session/other_tampered' };
    await h.repos.config.set(`runtime_workspace:${session.id}`, JSON.stringify(altered));

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers.some(b => b.code === 'BRANCH_MISMATCH' || b.code === 'WORKTREE_IDENTITY_MISMATCH')).toBe(true);
  });

  it('rejects cleanup when another unarchived session uses the same directory', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const first = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const firstWorkspace = (await h.runtime.getWorkspace(first.id))!;
    await h.runtime.archive(first.id);

    // 在同目录下创建一个未归档的 Session
    const otherSession = {
      id: 'ses_sibling',
      agentId: agent.id,
      state: 'idle' as const,
      cwd: firstWorkspace.repoRoot!,
      runId: 'run_sibling',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await h.repos.sessions.save(otherSession);

    const preview = await h.runtime.getWorkspaceCleanupPreview(first.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({ code: 'ACTIVE_SESSION_CONFLICT' })]);
  });

  it('rejects cleanup when active running verification exists in persistent storage or storage is unreadable', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const first = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const firstWorkspace = (await h.runtime.getWorkspace(first.id))!;
    await h.runtime.archive(first.id);

    // 写入同一相交路径的持久 running verification
    await h.repos.config.set(
      'runtime_verification:other_archived:running_1',
      JSON.stringify({
        id: 'running_1',
        sessionId: 'other_archived',
        cwd: firstWorkspace.cwd,
        status: 'running',
        startedAt: new Date().toISOString()
      })
    );

    const preview = await h.runtime.getWorkspaceCleanupPreview(first.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({ code: 'VERIFICATION_RUNNING' })]);

    // 模拟 storage 读取异常
    const originalList = h.repos.config.list;
    h.repos.config.list = async () => { throw new Error('database disk I/O error'); };
    const errPreview = await h.runtime.getWorkspaceCleanupPreview(first.id);
    expect(errPreview.canClean).toBe(false);
    expect(errPreview.blockers).toEqual([expect.objectContaining({ code: 'VERIFICATION_CHECK_FAILED' })]);
    h.repos.config.list = originalList;
  });

  it('rejects cleanup with 409 if fingerprint changes after preview', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(true);

    // 预览后写入新文件改变指纹
    const workspace = (await h.runtime.getWorkspace(session.id))!;
    writeFileSync(join(workspace.cwd, 'late_change.txt'), 'mutation\n');

    await expect(h.runtime.cleanWorkspace(session.id, preview.fingerprint)).rejects.toMatchObject({
      code: 'WORKSPACE_FINGERPRINT_MISMATCH',
      statusCode: 409
    });
  });

  it('deduplicates concurrent cleanup requests and does not remove worktree twice', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(true);

    let cleaningIntentLogged = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>(r => { releaseGate = r; });
    const originalCAS = h.repos.config.compareAndSet;
    h.repos.config.compareAndSet = async (k, e, v) => {
      const ok = await originalCAS!.call(h.repos.config, k, e, v);
      if (ok && k === `runtime_workspace:${session.id}` && JSON.parse(v).state === 'cleaning') {
        cleaningIntentLogged = true;
        await gate;
      }
      return ok;
    };

    const firstPromise = h.runtime.cleanWorkspace(session.id, preview.fingerprint);
    const secondPromise = h.runtime.cleanWorkspace(session.id, preview.fingerprint);

    await vi.waitFor(() => expect(cleaningIntentLogged).toBe(true));
    releaseGate();

    const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);
    expect(firstRes).toEqual(secondRes);
    expect(firstRes.ok).toBe(true);
    h.repos.config.compareAndSet = originalCAS;
  });

  it('blocks startSession from using a source directory that is currently being cleaned', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await h.runtime.archive(session.id);

    const workspace = (await h.runtime.getWorkspace(session.id))!;
    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);

    let cleaningGate!: () => void;
    const gate = new Promise<void>(r => { cleaningGate = r; });
    const originalCAS = h.repos.config.compareAndSet;
    h.repos.config.compareAndSet = async (k, e, v) => {
      const ok = await originalCAS!.call(h.repos.config, k, e, v);
      if (ok && k === `runtime_workspace:${session.id}` && JSON.parse(v).state === 'cleaning') {
        await gate;
      }
      return ok;
    };

    const cleanupRun = h.runtime.cleanWorkspace(session.id, preview.fingerprint);
    await vi.waitFor(() => expect((h.runtime as any).cleaningDirs.size).toBe(1));

    // 尝试以正在被清理的 worktree 目录作为 sourceCwd 启动新 session
    let reachedPrepare = false;
    (h.runtime as any).workspaces.prepare = async () => {
      reachedPrepare = true;
      throw new Error('should not reach prepare');
    };

    await expect(h.runtime.start({
      agentId: agent.id,
      cwd: workspace.repoRoot!,
      workspaceMode: 'worktree'
    })).rejects.toMatchObject({
      code: 'WORKSPACE_CONFLICT',
      statusCode: 409
    });
    expect(reachedPrepare).toBe(false);

    cleaningGate();
    await cleanupRun;
    h.repos.config.compareAndSet = originalCAS;
  });

  it('recovers to cleaned when removal succeeded on disk but final record save failed', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await h.runtime.archive(session.id);

    const workspace = (await h.runtime.getWorkspace(session.id))!;
    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);

    // 模拟在 Git worktree remove 成功后，写入 state: 'cleaned' 失败
    const originalCAS = h.repos.config.compareAndSet;
    let failCleanedSave = true;
    h.repos.config.compareAndSet = async (k, e, v) => {
      if (failCleanedSave && k === `runtime_workspace:${session.id}` && JSON.parse(v).state === 'cleaned') {
        failCleanedSave = false;
        throw new Error('disk crash while persisting cleaned state');
      }
      return originalCAS!.call(h.repos.config, k, e, v);
    };

    await expect(h.runtime.cleanWorkspace(session.id, preview.fingerprint)).rejects.toThrow();
    h.repos.config.compareAndSet = originalCAS;

    // 此时物理目录已删除，存储中停留在 cleaning 状态
    expect(existsSync(workspace.repoRoot!)).toBe(false);
    const unrecovered = JSON.parse((await h.repos.config.get(`runtime_workspace:${session.id}`))!);
    expect(unrecovered.state).toBe('cleaning');

    // 重试清理或 getWorkspace 触发收敛
    const retryResult = await h.runtime.cleanWorkspace(session.id, preview.fingerprint);
    expect(retryResult.ok).toBe(true);
    const recovered = await h.runtime.getWorkspace(session.id);
    expect(recovered?.state).toBe('cleaned');
    expect(recovered?.cleanedAt).toBeDefined();
  });

  it('does not falsely converge to cleaned when source is unreadable or repo cannot confirm removal', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const manager = new WorkspaceManager(createRepositories(':memory:').config, workspaceRoot);

    const record = await manager.prepare('test_fail_recovery', source, 'worktree');
    // 标记 cleaning 意图
    const intent = { ...record, state: 'cleaning' as const, revision: record.revision + 1 };
    await (manager as any).config.set(`runtime_workspace:${record.sessionId}`, JSON.stringify(intent));

    // 模拟目标目录丢失，但 source 也暂时被重命名不可读
    renameSync(record.repoRoot!, record.repoRoot! + '-moved');
    renameSync(source, source + '-moved');

    const recovered = await manager.get(record.sessionId);
    // 绝不能伪报成 cleaned！必须保留 cleaning 意图
    expect(recovered?.state).toBe('cleaning');
    expect(recovered?.cleanedAt).toBeUndefined();
  });

  it('ensures runtime shutdown waits for in-flight cleanups to settle', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);

    let cleaningCompleted = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>(r => { releaseGate = r; });
    const originalCAS = h.repos.config.compareAndSet;
    h.repos.config.compareAndSet = async (k, e, v) => {
      const ok = await originalCAS!.call(h.repos.config, k, e, v);
      if (ok && k === `runtime_workspace:${session.id}` && JSON.parse(v).state === 'cleaning') {
        setTimeout(() => {
          cleaningCompleted = true;
          releaseGate();
        }, 150);
        await gate;
      }
      return ok;
    };

    const cleanupPromise = h.runtime.cleanWorkspace(session.id, preview.fingerprint);
    const shutdownPromise = h.runtime.shutdown();

    await shutdownPromise;
    expect(cleaningCompleted).toBe(true);
    await cleanupPromise;
    h.repos.config.compareAndSet = originalCAS;
  });

  it('rejects cleanup when assume-unchanged hides tracked modifications, preserving file content', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await h.runtime.getWorkspace(session.id))!;
    const trackedPath = join(workspace.cwd, 'tracked.txt');

    // 对 tracked.txt 设置 assume-unchanged 标记，并写入唯一的未保存修改
    git(workspace.cwd, 'update-index', '--assume-unchanged', 'tracked.txt');
    writeFileSync(trackedPath, 'unsaved unique edit via assume-unchanged\n');
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({
      code: 'ASSUME_UNCHANGED_FILES',
      details: ['tracked.txt']
    })]);

    await expect(h.runtime.cleanWorkspace(session.id, preview.fingerprint)).rejects.toMatchObject({
      code: 'ASSUME_UNCHANGED_FILES',
      statusCode: 409
    });

    // 验证文件与目录必须完整存在且内容未丢失
    expect(existsSync(trackedPath)).toBe(true);
    expect(readFileSync(trackedPath, 'utf8')).toBe('unsaved unique edit via assume-unchanged\n');
  });

  it('rejects cleanup when skip-worktree hides tracked modifications, preserving file content', async () => {
    const source = repository();
    const workspaceRoot = temporary('dutydeck-ws-');
    const h = open(':memory:', { workspaceRoot });
    await h.runtime.initialize([agent]);

    const session = await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await h.runtime.getWorkspace(session.id))!;
    const trackedPath = join(workspace.cwd, 'tracked.txt');

    // 对 tracked.txt 设置 skip-worktree 标记，并写入唯一的未保存修改
    git(workspace.cwd, 'update-index', '--skip-worktree', 'tracked.txt');
    writeFileSync(trackedPath, 'unsaved unique edit via skip-worktree\n');
    await h.runtime.archive(session.id);

    const preview = await h.runtime.getWorkspaceCleanupPreview(session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({
      code: 'SKIP_WORKTREE_FILES',
      details: ['tracked.txt']
    })]);

    await expect(h.runtime.cleanWorkspace(session.id, preview.fingerprint)).rejects.toMatchObject({
      code: 'SKIP_WORKTREE_FILES',
      statusCode: 409
    });

    // 验证文件与目录必须完整存在且内容未丢失
    expect(existsSync(trackedPath)).toBe(true);
    expect(readFileSync(trackedPath, 'utf8')).toBe('unsaved unique edit via skip-worktree\n');
  });
});
