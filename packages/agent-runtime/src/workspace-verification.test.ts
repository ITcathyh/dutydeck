import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver, DriverFactory, Session, VerificationRecord } from '@dutydeck/shared';
import { RuntimeError } from '@dutydeck/shared';
import { DutydeckRuntime, type RuntimeOptions } from './index.js';
import { WorkspaceManager } from './workspace.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
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

function repository(subdirectory = false) {
  const root = temporary('dutydeck-git-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Dutydeck Test');
  writeFileSync(join(root, 'tracked.txt'), 'baseline\n');
  if (subdirectory) {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'code.txt'), 'nested\n');
  }
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  return root;
}

function driverFactory(sent: string[] = [], start = vi.fn(async () => {})): DriverFactory {
  return (_agent, _protocol, emit) => ({
    start,
    send: vi.fn(async prompt => { sent.push(prompt); emit({ type: 'text', data: { text: 'done' } }); }),
    interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {})
  });
}

function open(database: string, options: RuntimeOptions = {}, sent: string[] = []) {
  const repos = createRepositories(database);
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: driverFactory(sent), driverIdleTimeoutMs: 0, ...options
  });
  repositories.push(repos); runtimes.push(runtime);
  return { repos, runtime };
}

async function close(handle: ReturnType<typeof open>) {
  await handle.runtime.shutdown(); handle.repos.close();
  runtimes.splice(runtimes.indexOf(handle.runtime), 1);
  repositories.splice(repositories.indexOf(handle.repos), 1);
}

describe('managed Session workspaces', () => {
  it('allocates isolated worktrees from an explicit baseline without touching dirty source content', async () => {
    const source = repository(true);
    writeFileSync(join(source, 'tracked.txt'), 'dirty source\n');
    writeFileSync(join(source, 'untracked.txt'), 'keep me\n');
    const workspaceRoot = temporary('dutydeck-workspaces-');
    const startedCwds: string[] = [];
    const repos = createRepositories(':memory:');
    const runtime = new DutydeckRuntime(repos, {
      workspaceRoot, driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: configured => {
        startedCwds.push(configured.cwd!);
        return { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
      }
    });
    repositories.push(repos); runtimes.push(runtime);
    await runtime.initialize([agent]);
    const first = await runtime.start({ agentId: agent.id, cwd: join(source, 'nested'), workspaceMode: 'worktree' });
    const second = await runtime.start({ agentId: agent.id, cwd: join(source, 'nested'), workspaceMode: 'worktree' });

    expect(first.cwd).not.toBe(second.cwd);
    expect(startedCwds).toEqual([first.cwd, second.cwd]);
    expect(first.cwd.endsWith('/nested')).toBe(true);
    expect(readFileSync(join(source, 'tracked.txt'), 'utf8')).toBe('dirty source\n');
    expect(readFileSync(join(source, 'untracked.txt'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(join(dirname(first.cwd), 'tracked.txt'), 'utf8')).toBe('baseline\n');
    const workspace = await runtime.getWorkspace(first.id);
    expect(workspace).toMatchObject({ mode: 'worktree', state: 'ready', sourceCwd: join(source, 'nested'), cwd: first.cwd, baselineCommit: git(source, 'rev-parse', 'HEAD') });
    expect((await runtime.getSession(first.id))?.workspaceSourceCwd).toBe(join(source, 'nested'));
  });

  it('does not expose service credentials to Git worktree checkout hooks', async () => {
    const source = repository(); const workspaceRoot = temporary('dutydeck-workspaces-');
    const markerFile = join(temporary('dutydeck-hook-'), 'observed.txt');
    const hook = join(source, '.git', 'hooks', 'post-checkout');
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\nprintf '%s' "\${DUTYDECK_GITHUB_TOKEN-unset}" > ${JSON.stringify(markerFile)}\n`);
    chmodSync(hook, 0o755);
    const previous = process.env.DUTYDECK_GITHUB_TOKEN;
    process.env.DUTYDECK_GITHUB_TOKEN = 'service-hook-secret-0123456789';
    const h = open(':memory:', { workspaceRoot }); await h.runtime.initialize([agent]);
    try {
      await h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
      expect(readFileSync(markerFile, 'utf8')).toBe('unset');
    } finally {
      if (previous === undefined) delete process.env.DUTYDECK_GITHUB_TOKEN;
      else process.env.DUTYDECK_GITHUB_TOKEN = previous;
    }
  });

  it('persists a failed preparation, starts no driver, and can retry the same owned intent', async () => {
    const source = temporary('dutydeck-late-git-');
    const workspaceRoot = temporary('dutydeck-workspaces-');
    const start = vi.fn(async () => {});
    const repos = createRepositories(':memory:');
    const runtime = new DutydeckRuntime(repos, {
      workspaceRoot, driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: driverFactory([], start)
    });
    repositories.push(repos); runtimes.push(runtime);
    await runtime.initialize([agent]);
    await expect(runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' })).rejects.toMatchObject({ code: 'WORKSPACE_PREPARATION_FAILED' });
    const [failed] = await runtime.listSessions();
    expect(failed).toMatchObject({ state: 'failed', workspaceMode: 'worktree', workspaceSourceCwd: source });
    expect(await runtime.getWorkspace(failed!.id)).toMatchObject({ state: 'failed', sourceCwd: source });
    expect(start).not.toHaveBeenCalled();

    git(source, 'init', '-q'); git(source, 'config', 'user.email', 'test@example.com'); git(source, 'config', 'user.name', 'Dutydeck Test');
    writeFileSync(join(source, 'code.txt'), 'ready\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'baseline');
    await expect(runtime.restart(failed!.id)).resolves.toMatchObject({ state: 'idle', workspaceMode: 'worktree' });
    expect(start).toHaveBeenCalledOnce();
  });

  it('refuses a persisted worktree whose branch identity changed and retains it on archive', async () => {
    const source = repository();
    const database = join(temporary('dutydeck-db-'), 'runtime.db');
    const workspaceRoot = temporary('dutydeck-workspaces-');
    const first = open(database, { workspaceRoot });
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
    const workspace = (await first.runtime.getWorkspace(session.id))!;
    await first.runtime.stop(session.id);
    expect(existsSync(workspace.repoRoot!)).toBe(true);
    const persisted = (await first.repos.sessions.get(session.id))!;
    await first.repos.sessions.save({ ...persisted, state: 'idle' });
    await close(first);
    git(workspace.repoRoot!, 'checkout', '--detach', '-q');
    const second = open(database, { workspaceRoot });
    await second.runtime.initialize([agent]);
    expect(await second.runtime.getSession(session.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('no longer belongs') });
    await second.runtime.archive(session.id);
    expect(existsSync(workspace.repoRoot!)).toBe(true);
  });

  it('persists fixed worktree intent before Git mutation and reuses it after source HEAD advances', async () => {
    const source = repository(); const workspaceRoot = temporary('dutydeck-workspaces-');
    const repos = createRepositories(':memory:'); repositories.push(repos);
    const compareAndSet = repos.config.compareAndSet!.bind(repos.config);
    let simulateCrash = true;
    repos.config.compareAndSet = async (key, expected, value) => {
      const state = (JSON.parse(value) as { state?: string }).state;
      if (simulateCrash && (state === 'ready' || state === 'failed')) throw new Error('simulated crash after git worktree add');
      return compareAndSet(key, expected, value);
    };
    const manager = new WorkspaceManager(repos.config, workspaceRoot);
    await expect(manager.prepare('ses_crash', source, 'worktree')).rejects.toThrow('simulated crash');
    const intent = JSON.parse((await repos.config.get('runtime_workspace:ses_crash'))!);
    expect(intent).toMatchObject({ state: 'preparing', baselineCommit: git(source, 'rev-parse', 'HEAD'), branch: 'dutydeck/session/ses_crash' });
    expect(existsSync(intent.repoRoot)).toBe(true);

    writeFileSync(join(source, 'later.txt'), 'later\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'later source head');
    simulateCrash = false;
    const recovered = await manager.prepare('ses_crash', source, 'worktree');
    expect(recovered.baselineCommit).toBe(intent.baselineCommit);
    expect(git(recovered.repoRoot!, 'rev-parse', 'HEAD')).toBe(intent.baselineCommit);
    await expect(manager.prepare('ses_crash', temporary('dutydeck-other-source-'), 'worktree')).rejects.toMatchObject({ code: 'WORKSPACE_OWNERSHIP_MISMATCH' });
  });

  it('recovers a SQLite-persisted preparing workspace on Runtime initialization without archiving the Session', async () => {
    const source = repository(); const workspaceRoot = temporary('dutydeck-workspaces-');
    const database = join(temporary('dutydeck-db-'), 'runtime.db');
    const seeded = createRepositories(database);
    const timestamp = new Date().toISOString();
    await seeded.sessions.save({ id: 'ses_runtime_crash', agentId: agent.id, state: 'created', cwd: source, protocol: 'acp', runId: 'run_crash', createdAt: timestamp, updatedAt: timestamp });
    const compareAndSet = seeded.config.compareAndSet!.bind(seeded.config);
    seeded.config.compareAndSet = async (key, expected, value) => {
      const state = (JSON.parse(value) as { state?: string }).state;
      if (state === 'ready' || state === 'failed') throw new Error('simulated daemon crash after worktree add');
      return compareAndSet(key, expected, value);
    };
    const manager = new WorkspaceManager(seeded.config, workspaceRoot);
    await expect(manager.prepare('ses_runtime_crash', source, 'worktree')).rejects.toThrow('simulated daemon crash');
    const fixedBaseline = (await manager.get('ses_runtime_crash'))!.baselineCommit;
    seeded.close();
    writeFileSync(join(source, 'new-head.txt'), 'new head\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'advance source');

    const recovered = open(database, { workspaceRoot }); await recovered.runtime.initialize([agent]);
    expect(await recovered.runtime.getSession('ses_runtime_crash')).toMatchObject({ state: 'idle', archivedAt: null, workspaceMode: 'worktree' });
    expect(await recovered.runtime.getWorkspace('ses_runtime_crash')).toMatchObject({ state: 'ready', baselineCommit: fixedBaseline });
  });
});

describe('user-command verification evidence', () => {
  it('records success, failure, timeout, truncation, task linkage, and later staleness', async () => {
    const source = repository();
    const h = open(':memory:');
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    const task = await h.runtime.send(session.id, 'make a task');
    const passed = await h.runtime.runVerification(session.id, { command: `${process.execPath} -e "process.stdout.write('ok')"` }, 'owner');
    expect(passed).toMatchObject({ status: 'passed', exitCode: 0, output: 'ok', stale: false, taskId: task.id, actorId: 'owner' });
    expect(await h.runtime.runVerification(session.id, { command: `${process.execPath} -e "process.exit(7)"` })).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(await h.runtime.runVerification(session.id, { command: `${process.execPath} -e "setTimeout(()=>{},2000)"`, timeoutSeconds: 1 })).toMatchObject({ status: 'timed_out' });
    const truncated = await h.runtime.runVerification(session.id, { command: `${process.execPath} -e "process.stdout.write('x'.repeat(140000))"` });
    expect(truncated.status).toBe('passed'); expect(truncated.outputTruncated).toBe(true); expect(Buffer.byteLength(truncated.output)).toBeLessThanOrEqual(128 * 1024);

    await writeFile(join(source, 'tracked.txt'), 'changed later\n');
    const listed = await h.runtime.getVerifications(session.id);
    expect(listed[0]!.startedAt >= listed.at(-1)!.startedAt).toBe(true);
    expect(listed.find(item => item.id === passed.id)).toMatchObject({ stale: true, staleReason: 'code_changed' });
  });

  it('keeps missing and unreadable fingerprints stale without asserting that code changed', async () => {
    const source = repository(); const h = open(':memory:'); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    expect(await h.runtime.getVerifications(session.id)).toEqual([]);
    const passed = await h.runtime.runVerification(session.id, { command: 'true' });
    const storageKey = `runtime_verification:${session.id}:${passed.id}`;
    const stored = JSON.parse((await h.repos.config.get(storageKey))!);
    delete stored.beforeFingerprint;
    await h.repos.config.set(storageKey, JSON.stringify(stored));
    expect(await h.runtime.getVerifications(session.id)).toEqual([expect.objectContaining({ status: 'passed', stale: true, staleReason: 'record_fingerprint_missing' })]);
    rmSync(join(source, '.git'), { recursive: true, force: true });
    expect(await h.runtime.getVerifications(session.id)).toEqual([expect.objectContaining({ status: 'passed', stale: true, staleReason: 'current_fingerprint_unavailable' })]);
  });

  it('does not inherit service credentials and redacts retained output across chunks and the cap boundary', async () => {
    const source = repository(); const h = open(':memory:'); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    const marker = 'service-token-cross-chunk-0123456789-SECRET';
    const previous = process.env.DUTYDECK_GITHUB_TOKEN;
    process.env.DUTYDECK_GITHUB_TOKEN = marker;
    const script = join(source, 'credential-output.mjs');
    const firstPrefixBytes = Buffer.byteLength('inherited=\n') + Buffer.byteLength(marker) + 1;
    const fillerBytes = 128 * 1024 - firstPrefixBytes - 4;
    writeFileSync(script, `
const marker = process.env.EXPLICIT_MARKER;
process.stdout.write('inherited=' + (process.env.DUTYDECK_GITHUB_TOKEN ?? '') + '\\n');
process.stdout.write(marker.slice(0, 9));
await new Promise(resolve => setTimeout(resolve, 10));
process.stdout.write(marker.slice(9) + '\\n');
process.stdout.write('x'.repeat(${fillerBytes}));
process.stdout.write(marker.slice(0, 4));
await new Promise(resolve => setTimeout(resolve, 10));
process.stdout.write(marker.slice(4));
    `);
    try {
      const result = await h.runtime.runVerification(session.id, { command: `EXPLICIT_MARKER=${JSON.stringify(marker)} ${process.execPath} ${JSON.stringify(script)}` });
      expect(result).toMatchObject({ status: 'passed', outputTruncated: true });
      expect(result.command).toContain('[REDACTED]');
      expect(result.command).not.toContain(marker);
      expect(result.output).toContain('inherited=\n');
      expect(result.output.match(/\[REDACTED\]/g)?.length).toBe(2);
      expect(result.output).not.toContain(marker);
      expect(result.output).not.toContain(marker.slice(0, 9));
      expect((await h.repos.config.list!(`runtime_verification:${session.id}:`))[0]!.value).not.toContain(marker);
    } finally {
      if (previous === undefined) delete process.env.DUTYDECK_GITHUB_TOKEN;
      else process.env.DUTYDECK_GITHUB_TOKEN = previous;
    }
  });

  it('fingerprints command changes, ignores Dutydeck artifacts, and rejects non-repositories', async () => {
    const source = repository();
    const h = open(':memory:'); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    const changed = await h.runtime.runVerification(session.id, { command: `${process.execPath} -e "require('fs').appendFileSync('tracked.txt','command change\\n')"` });
    expect(changed).toMatchObject({ status: 'unverified', stale: true, staleReason: 'changed_during_run', error: 'Repository content changed during verification' });
    expect(changed.beforeFingerprint).not.toBe(changed.afterFingerprint);
    mkdirSync(join(source, '.dutydeck'), { recursive: true }); writeFileSync(join(source, '.dutydeck', 'generated'), 'ignored');
    expect((await h.runtime.getVerifications(session.id)).find(item => item.id === changed.id)?.stale).toBe(true);

    const plain = temporary('dutydeck-nonrepo-');
    const other = await h.runtime.start({ agentId: agent.id, cwd: plain });
    await expect(h.runtime.runVerification(other.id, { command: 'true' })).rejects.toMatchObject({ code: 'VERIFICATION_NOT_GIT' });
  });

  it('fingerprints tracked deletions and dirty submodule content without false-current evidence', async () => {
    const source = repository(); const child = repository();
    git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'deps/child');
    git(source, 'commit', '-qam', 'add submodule');
    const h = open(':memory:'); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    const initial = await h.runtime.runVerification(session.id, { command: 'true' });
    expect(initial).toMatchObject({ status: 'passed', stale: false });

    rmSync(join(source, 'tracked.txt'));
    const deletion = await h.runtime.runVerification(session.id, { command: 'true' });
    expect(deletion).toMatchObject({ status: 'passed', stale: false });
    writeFileSync(join(source, 'deps/child/tracked.txt'), 'dirty submodule\n');
    const evidence = await h.runtime.getVerifications(session.id);
    expect(evidence.find(item => item.id === deletion.id)?.stale).toBe(true);
  });

  it('returns 400 for malformed verification and workspace inputs', async () => {
    const source = repository(); const h = open(':memory:'); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    await expect(h.runtime.runVerification(session.id, null as any)).rejects.toMatchObject({ statusCode: 400, code: 'VERIFICATION_COMMAND_REQUIRED' });
    await expect(h.runtime.runVerification(session.id, { command: null } as any)).rejects.toMatchObject({ statusCode: 400, code: 'VERIFICATION_COMMAND_REQUIRED' });
    await expect(h.runtime.start({ agentId: agent.id, cwd: null as any })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_WORKSPACE_SOURCE' });
    await expect(h.runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'isolated' as any })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_WORKSPACE_MODE' });
  });

  it('keeps verification mutually exclusive with active and queued Agent work and rechecks authorization', async () => {
    const source = repository(); const sent: string[] = []; const authorize = vi.fn(async () => {});
    const h = open(':memory:', { authorizeExecution: authorize }, sent); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    const verifying = h.runtime.runVerification(session.id, { command: `${process.execPath} -e "setTimeout(()=>{},300)"` }, 'owner');
    await vi.waitFor(async () => expect((await h.runtime.getVerifications(session.id))[0]?.status).toBe('running'));
    const queued = await h.runtime.dispatch(session.id, 'after verification');
    expect(sent).toEqual([]); expect(queued.status).toBe('queued');
    await verifying;
    await vi.waitFor(() => expect(sent).toEqual(['after verification']));
    expect(authorize.mock.calls.filter(call => call[1] === 'owner')).toHaveLength(2);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const busyDriver: AgentDriver = { start: async () => {}, send: () => gate, interrupt: async () => {}, resume: async () => {}, stop: async () => { release(); } };
    const busyRepos = createRepositories(':memory:');
    const busy = new DutydeckRuntime(busyRepos, { driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => busyDriver });
    repositories.push(busyRepos); runtimes.push(busy);
    await busy.initialize([agent]); const busySession = await busy.start({ agentId: agent.id, cwd: source });
    void busy.dispatch(busySession.id, 'busy'); await vi.waitFor(async () => expect((await busy.getTasks(busySession.id))[0]?.status).toBe('running'));
    await expect(busy.runVerification(busySession.id, { command: 'true' })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    release();
  });

  it.each([false, true])('fences admission and links evidence only to earlier work (prior task: %s)', async withPriorTask => {
    const source = repository(); const sent: string[] = [];
    let releaseAuthorization!: () => void;
    const authorization = new Promise<void>(resolve => { releaseAuthorization = resolve; });
    let blockAuthorization = false;
    const authorize = vi.fn(async () => { if (blockAuthorization) await authorization; });
    const h = open(':memory:', { authorizeExecution: authorize }, sent); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    const priorTask = withPriorTask ? await h.runtime.send(session.id, 'earlier completed work') : undefined;
    sent.splice(0); authorize.mockClear(); blockAuthorization = true;
    const verification = h.runtime.runVerification(session.id, { command: `${process.execPath} -e "setTimeout(()=>{},100)"` });
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    await expect(h.runtime.runVerification(session.id, { command: 'true' })).rejects.toMatchObject({ code: 'VERIFICATION_IN_PROGRESS' });
    const accepted = await h.runtime.dispatch(session.id, 'accepted behind verification');
    expect(accepted.status).toBe('queued'); expect(sent).toEqual([]);
    releaseAuthorization();
    const evidence = await verification;
    expect(evidence.status).toBe('passed');
    expect(evidence.taskId).toBe(priorTask?.id);
    expect(evidence.taskId).not.toBe(accepted.id);
    await vi.waitFor(() => expect(sent).toEqual(['accepted behind verification']));
    expect((await h.runtime.getTasks(session.id)).find(task => task.id === accepted.id)?.status).toBe('completed');
  });

  it('turns a persisted running verification into interrupted evidence on restart', async () => {
    const source = repository(); const database = join(temporary('dutydeck-db-'), 'runtime.db');
    const first = open(database); await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id, cwd: source });
    const startedAt = new Date().toISOString();
    const record: VerificationRecord = { schemaVersion: 1, revision: 1, id: 'verification_orphan', sessionId: session.id, command: 'long command', cwd: source, status: 'running', startedAt, output: '', outputTruncated: false };
    await first.repos.config.set(`runtime_verification:${session.id}:${record.id}`, JSON.stringify({ ...record, processStage: 'awaiting_process' }));
    await close(first);
    const second = open(database); await second.runtime.initialize([agent]);
    expect(await second.runtime.getVerifications(session.id)).toEqual([expect.objectContaining({ id: record.id, status: 'interrupted', revision: 2, stale: true })]);
  });

  it('keeps a Session execution-blocked when persisted verification process identity cannot be recovered', async () => {
    const source = repository(); const database = join(temporary('dutydeck-db-'), 'runtime.db');
    const first = open(database); await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id, cwd: source });
    const record: VerificationRecord = {
      schemaVersion: 1, revision: 1, id: 'verification_unknown_process', sessionId: session.id,
      command: 'unknown legacy command', cwd: source, status: 'running', startedAt: new Date().toISOString(),
      output: '', outputTruncated: false
    };
    await first.repos.config.set(`runtime_verification:${session.id}:${record.id}`, JSON.stringify({ ...record, processStage: 'command_started' }));
    await first.repos.tasks.save({ id: 'queued_before_crash', sessionId: session.id, prompt: 'deferred work', status: 'queued', executionContext: { agentPrompt: 'deferred work' }, createdAt: record.startedAt, updatedAt: record.startedAt });
    await close(first);

    const factory = vi.fn(driverFactory());
    const second = open(database, { driverFactory: factory });
    await second.runtime.initialize([agent]);
    expect(await second.runtime.getSession(session.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('process identity is missing') });
    expect(await second.runtime.getWorkspace(session.id)).toMatchObject({ state: 'ready' });
    expect(await second.runtime.getVerifications(session.id)).toEqual([expect.objectContaining({ id: record.id, status: 'running' })]);

    const blocked = { code: 'VERIFICATION_RECOVERY_BLOCKED', statusCode: 409 };
    await expect(second.runtime.restart(session.id)).rejects.toMatchObject(blocked);
    await expect(second.runtime.resume(session.id)).rejects.toMatchObject(blocked);
    await expect(second.runtime.send(session.id, 'must not run')).rejects.toMatchObject(blocked);
    await expect(second.runtime.dispatch(session.id, 'must not queue')).rejects.toMatchObject(blocked);
    await expect(second.runtime.getTerminalDriver(session.id)).rejects.toMatchObject(blocked);
    await expect(second.runtime.runVerification(session.id, { command: 'true' })).rejects.toMatchObject(blocked);
    expect(second.runtime.getDriver(session.id)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();

    await expect(second.runtime.stop(session.id)).resolves.toBeUndefined();
    expect(await second.runtime.getSession(session.id)).toMatchObject({ state: 'stopped' });
    expect(await second.runtime.getTasks(session.id)).toEqual([expect.objectContaining({ id: 'queued_before_crash', status: 'cancelled' })]);
    await expect(second.runtime.archive(session.id)).resolves.toMatchObject({ archivedAt: expect.any(String) });
    expect(await second.runtime.getVerifications(session.id)).toHaveLength(1);
  });

  it('kills an identified verification process group after an abrupt daemon crash before unlocking the Session', async () => {
    if (process.platform !== 'linux') return;
    const source = repository(); const directory = temporary('dutydeck-crash-verification-');
    const database = join(directory, 'runtime.db'); const marker = join(directory, 'writes.log');
    const writer = join(source, 'verification-writer.mjs');
    writeFileSync(writer, `import { appendFileSync } from 'node:fs';\nconst file=process.argv[2];\nsetInterval(()=>appendFileSync(file,'x'),20);\n`);
    const fixture = join(process.cwd(), 'packages/agent-runtime/tests/fixtures/verification-crash.mts');
    const fixtureTsconfig = join(process.cwd(), 'packages/agent-runtime/tests/fixtures/tsconfig.json');
    const child = spawn(process.execPath, ['--conditions=development', '--import', 'tsx', fixture, database, source, marker, writer], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TSX_TSCONFIG_PATH: fixtureTsconfig }
    });
    let sessionId = '';
    try {
      sessionId = await new Promise<string>((resolve, reject) => {
        let output = '';
        let errorOutput = '';
        child.stderr!.on('data', chunk => { errorOutput += chunk.toString(); });
        child.stdout!.on('data', chunk => {
          output += chunk.toString();
          const match = output.match(/READY (ses_[^\s]+)/);
          if (match) resolve(match[1]!);
        });
        child.once('error', reject);
        child.once('exit', code => { if (!sessionId) reject(new Error(`crash fixture exited early: ${code}: ${errorOutput}`)); });
      });
      await vi.waitFor(() => expect(existsSync(marker) && readFileSync(marker).length > 0).toBe(true));
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
      await new Promise(resolve => setTimeout(resolve, 80));
      const growingSize = readFileSync(marker).length;
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(readFileSync(marker).length).toBeGreaterThan(growingSize);

      const recovered = open(database); await recovered.runtime.initialize([agent]);
      const stoppedSize = readFileSync(marker).length;
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(readFileSync(marker).length).toBe(stoppedSize);
      expect((await recovered.runtime.getVerifications(sessionId))[0]).toMatchObject({ status: 'interrupted' });
      expect(await recovered.runtime.getSession(sessionId)).not.toMatchObject({ state: 'failed' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (sessionId && existsSync(database)) {
        const cleanupRepos = createRepositories(database);
        try {
          const raw = (await cleanupRepos.config.list!(`runtime_verification:${sessionId}:`))[0]?.value;
          const processGroupId = raw && JSON.parse(raw).processIdentity?.processGroupId;
          if (processGroupId) { try { process.kill(-processGroupId, 'SIGKILL'); } catch { /* Already recovered. */ } }
        } finally { cleanupRepos.close(); }
      }
    }
  }, 20_000);

  it('kills and settles a verification during graceful shutdown', async () => {
    const source = repository(); const h = open(':memory:'); await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    const running = h.runtime.runVerification(session.id, { command: `${process.execPath} -e "setTimeout(()=>{},5000)"` });
    await vi.waitFor(async () => expect((await h.runtime.getVerifications(session.id))[0]?.status).toBe('running'));
    await h.runtime.shutdown();
    await expect(running).resolves.toMatchObject({ status: 'interrupted' });
    expect(await h.runtime.getVerifications(session.id)).toEqual([expect.objectContaining({ status: 'interrupted' })]);
  });
});

describe('immutable task prompt preparation', () => {
  it.each(['acp', 'pty-cli'] as const)('delivers prepared prompt content through the %s driver', async protocol => {
    const source = repository(); const sent: string[] = [];
    const repos = createRepositories(':memory:');
    const runtime = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      probe: () => ({ protocol, available: true, pause: false, resume: true }),
      driverFactory: driverFactory(sent),
      prepareTaskPrompt: async (_session, prompt) => ({ agentPrompt: `${prompt}\nresolved skill body` })
    });
    repositories.push(repos); runtimes.push(runtime);
    await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id, cwd: source });
    await runtime.send(session.id, 'visible prompt');
    expect(sent).toEqual(['visible prompt\nresolved skill body']);
  });

  it('snapshots accepted queued prompts, exposes metadata only, and does not resolve idempotent replay again', async () => {
    const source = repository(); const database = join(temporary('dutydeck-db-'), 'runtime.db');
    const skill = join(source, 'SKILL.md'); writeFileSync(skill, 'version one');
    let allow!: () => void; const gate = new Promise<void>(resolve => { allow = resolve; });
    const prepare = vi.fn(async (_session: Session, prompt: string, requests?: string[]) => {
      const content = await readFile(skill, 'utf8');
      return { agentPrompt: `${prompt}\n[skill]\n${content}`, skillDeliveries: requests?.map(name => ({ name, path: skill, source: 'workspace' as const, digest: createHash('sha256').update(content).digest('hex'), mode: 'prompt' as const })) };
    });
    const first = open(database, { prepareTaskPrompt: prepare, authorizeExecution: () => gate, sessionPrompt: (_session, prompt) => `[run]\n${prompt}` });
    await first.runtime.initialize([agent]); const session = await first.runtime.start({ agentId: agent.id, cwd: source });
    const accepted = await first.runtime.dispatch(session.id, 'do work', 'queue', 'channel prompt', undefined, 'owner', 'delivery-1', ['skill-a']);
    const replay = await first.runtime.dispatch(session.id, 'do work', 'queue', 'channel prompt changed but ignored by replay', undefined, 'owner', 'delivery-1', ['skill-a']);
    expect(replay).toMatchObject({ id: accepted.id, replayed: true }); expect(prepare).toHaveBeenCalledOnce();
    expect(accepted.skillDeliveries).toEqual([expect.objectContaining({ name: 'skill-a', path: skill, mode: 'prompt' })]);
    expect(accepted).not.toHaveProperty('executionContext');
    writeFileSync(skill, 'version two');
    const stopping = first.runtime.shutdown(); allow(); await stopping;
    first.repos.close(); runtimes.splice(runtimes.indexOf(first.runtime), 1); repositories.splice(repositories.indexOf(first.repos), 1);

    const sent: string[] = []; const second = open(database, { prepareTaskPrompt: prepare, sessionPrompt: (_session, prompt) => `[run]\n${prompt}` }, sent);
    await second.runtime.initialize([agent]);
    await vi.waitFor(() => expect(sent).toEqual(['[run]\nchannel prompt\n[skill]\nversion one']));
    expect(prepare).toHaveBeenCalledOnce();
    const persisted = (await second.repos.tasks.listBySession(session.id))[0]!;
    expect(persisted.executionContext?.agentPrompt).toContain('version one');
    expect(persisted.executionContext?.agentPrompt).not.toContain('version two');
    expect((await second.runtime.getTasks(session.id))[0]).not.toHaveProperty('executionContext');
  });

  it('prepares direct sends and rejects explicit Skill requests without a resolver', async () => {
    const source = repository(); const sent: string[] = [];
    const h = open(':memory:', { prepareTaskPrompt: async (_session, prompt) => ({ agentPrompt: `snapshot:${prompt}` }) }, sent);
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    await h.runtime.send(session.id, 'visible', 'agent', undefined, undefined, ['skill-a']);
    expect(sent).toEqual(['snapshot:agent']);
    const without = open(':memory:'); await without.runtime.initialize([agent]); const other = await without.runtime.start({ agentId: agent.id, cwd: source });
    await expect(without.runtime.dispatch(other.id, 'work', 'queue', 'work', undefined, undefined, undefined, ['skill-a'])).rejects.toMatchObject({ code: 'SKILL_DELIVERY_UNAVAILABLE' });
  });

  it('revalidates a queued task immediately before reconnecting its driver', async () => {
    const source = repository(); const order: string[] = [];
    const h = open(':memory:', {
      authorizeExecution: async () => { order.push('execution'); },
      authorizeTask: async (_session, _task, phase) => { order.push(`task:${phase}`); },
      driverFactory: () => ({ start: async () => { order.push('start'); }, send: async () => { order.push('send'); }, interrupt: async () => {}, resume: async () => {}, stop: async () => {} })
    });
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    order.length = 0;
    await h.runtime.dispatch(session.id, 'work');
    await vi.waitFor(() => expect(order).toContain('send'));
    expect(order).toEqual(['execution', 'task:prepare', 'execution', 'task:submit', 'send']);
  });

  it('rechecks task authority after asynchronous prompt preparation and does not submit when revoked', async () => {
    const source = repository(); const sent: string[] = [];
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>(resolve => { releasePrompt = resolve; });
    let promptStarted!: () => void;
    const started = new Promise<void>(resolve => { promptStarted = resolve; });
    let revoked = false;
    const h = open(':memory:', {
      sessionPrompt: async (_session, prompt) => { promptStarted(); await promptGate; return prompt; },
      authorizeTask: async (_session, _task, phase) => {
        if (phase === 'submit' && revoked) throw new RuntimeError('SESSION_AUTOMATION_TASK_STALE_HEAD', 'HEAD changed', 409);
      }
    }, sent);
    await h.runtime.initialize([agent]); const session = await h.runtime.start({ agentId: agent.id, cwd: source });
    const task = await h.runtime.dispatch(session.id, 'will be revoked');
    await started; revoked = true; releasePrompt();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(item => item.id === task.id)?.status).toBe('interrupted'));
    expect(sent).toEqual([]);
    expect((await h.runtime.getEvents(session.id)).some(event => event.type === 'error')).toBe(false);
  });
});
