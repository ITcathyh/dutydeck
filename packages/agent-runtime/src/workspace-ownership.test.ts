import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';
import { owner } from './ownership.js';

const fsGate = vi.hoisted(() => ({ path: '', entered: undefined as (() => void) | undefined, gate: undefined as Promise<void> | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, realpath: async (...args: Parameters<typeof original.realpath>) => {
    const result = await original.realpath(...args);
    if (String(args[0]) === fsGate.path && fsGate.gate) {
      const gate = fsGate.gate; fsGate.gate = undefined; fsGate.entered?.(); await gate;
    }
    return result;
  } };
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const agent: AgentConfig = { id: 'workspace-owner', name: 'Workspace', command: 'unused', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { fsGate.path = ''; fsGate.gate = undefined; fsGate.entered = undefined; for (const cleanup of cleanups.splice(0)) await cleanup(); });
function git(cwd: string, ...args: string[]) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim(); }
async function fixture(archive = true) {
  const root = mkdtempSync(join(tmpdir(), 'dutydeck-workspace-owner-')); const source = join(root, 'source');
  git(root, 'init', '-q', source); git(source, 'config', 'user.name', 'test'); git(source, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(source, 'file'), 'baseline'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'baseline');
  const repos = createRepositories(join(root, 'runtime.sqlite'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { workspaceRoot: join(root, 'workspaces'), driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: () => ({ start: async () => {}, send: async () => {}, stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true }) });
  let closed = false;
  const close = async () => { if (closed) return; await runtime.shutdown(); repos.close(); closed = true; };
  cleanups.push(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id, cwd: source, workspaceMode: 'worktree' });
  const workspace = (await runtime.getWorkspace(session.id))!; if (archive) await runtime.archive(session.id);
  return { runtime, repos, root, source, session, workspace, close };
}

it('rejects new cleanup after shutdown without deleting its worktree', async () => {
  const h = await fixture(); const preview = await h.runtime.getWorkspaceCleanupPreview(h.session.id);
  await h.runtime.shutdown();
  await expect(h.runtime.cleanWorkspace(h.session.id, preview.fingerprint)).rejects.toMatchObject({ code: 'RUNTIME_SHUTTING_DOWN' });
  expect(existsSync(h.workspace.cwd)).toBe(true);
});

it('owns an admitted archived cleanup independently of the caller lifecycle', async () => {
  const h = await fixture(); const preview = await h.runtime.getWorkspaceCleanupPreview(h.session.id);
  const stale = owner('another-session'); stale.revoke();
  const cleaning = (h.runtime as any).mutations.run(stale, () => h.runtime.cleanWorkspace(h.session.id, preview.fingerprint));
  expect((await cleaning).ok).toBe(true); expect(existsSync(h.workspace.cwd)).toBe(false);
});

it.each(['getWorkspace', 'getSession', 'listSessions'] as const)('seals %s recovery before closing SQLite', async method => {
  const h = await fixture();
  const cleaning = { ...h.workspace, state: 'cleaning', revision: h.workspace.revision + 1 };
  await h.repos.config.set('runtime_workspace:' + h.session.id, JSON.stringify(cleaning));
  git(h.source, 'worktree', 'remove', h.workspace.repoRoot!);
  const manager = (h.runtime as any).workspaces; const recover = manager.tryRecoverCleaning.bind(manager);
  const entered = deferred(), gate = deferred(), finished = deferred(); let once = true;
  manager.tryRecoverCleaning = async (...args: unknown[]) => {
    if (once) { once = false; entered.resolve(); await gate.promise; }
    try { return await recover(...args); } finally { finished.resolve(); }
  };
  const cas = vi.spyOn(h.repos.config, 'compareAndSet');
  const reading = (method === 'listSessions' ? h.runtime.listSessions() : h.runtime[method](h.session.id)).catch(error => error);
  await entered.promise; await h.close(); gate.resolve(); await finished.promise; await reading;
  expect(cas).not.toHaveBeenCalled();
});

it('blocks getWorkspaceCleanupPreview during unrecovered cleaning before closing SQLite', async () => {
  const h = await fixture();
  const cleaning = { ...h.workspace, state: 'cleaning', revision: h.workspace.revision + 1 };
  await h.repos.config.set('runtime_workspace:' + h.session.id, JSON.stringify(cleaning));
  await expect(h.runtime.getWorkspaceCleanupPreview(h.session.id)).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
  await h.close();
});

it.each([false, true])('retains directories with persisted unverified resources (intersecting: %s)', async intersecting => {
  const h = await fixture();
  let blockedId = h.session.id;
  if (intersecting) {
    const other = await h.runtime.start({ agentId: agent.id, cwd: h.workspace.cwd });
    await h.runtime.archive(other.id);
    blockedId = other.id;
  }
  await h.repos.config.set('runtime_driver_stop_block:' + blockedId, JSON.stringify({ sessionId: blockedId, runId: 'old-run', reason: 'resource not verified' }));
  if (intersecting) {
    const preview = await h.runtime.getWorkspaceCleanupPreview(h.session.id);
    expect(preview.canClean).toBe(false);
    expect(preview.blockers.some(blocker => blocker.code === 'DRIVER_STOP_UNVERIFIED' || blocker.code === 'DRIVER_STOP_BLOCKED')).toBe(true);
    await expect(h.runtime.cleanWorkspace(h.session.id, preview.fingerprint)).rejects.toMatchObject({ code: 'DRIVER_STOP_BLOCKED' });
  } else {
    await expect(h.runtime.getWorkspaceCleanupPreview(h.session.id)).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
  }
  expect(existsSync(h.workspace.cwd)).toBe(true);
});

it('does not reload a stale persisted stop block after physical proof clears it', async () => {
  const h = await fixture(); const key = 'runtime_driver_stop_block:' + h.session.id;
  await h.repos.config.set(key, JSON.stringify({ sessionId: h.session.id, runId: 'old-run', reason: 'pending proof' }));
  await (h.runtime as any).loadStopBlock(h.session.id);
  const entered = deferred(), gate = deferred(); const get = h.repos.config.get.bind(h.repos.config);
  h.repos.config.get = async name => {
    const value = await get(name);
    if (name === key) { entered.resolve(); await gate.promise; }
    return value;
  };
  const runtime = h.runtime as any;
  const reading = runtime.mutations.run(owner(h.session.id), () => runtime.loadStopBlock(h.session.id));
  await entered.promise;
  let cleared = false;
  const clearing = runtime.mutations.run(undefined, () => runtime.clearStopBlock(h.session.id)).then(() => { cleared = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(cleared).toBe(true);
  gate.resolve(); await reading; await clearing;
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined();
  expect(await get(key)).toBe('');
});

it('waits for an entered final cleanup write before shutdown completes', async () => {
  const h = await fixture(); const preview = await h.runtime.getWorkspaceCleanupPreview(h.session.id);
  const entered = deferred(), gate = deferred(); const cas = h.repos.config.compareAndSet!.bind(h.repos.config);
  h.repos.config.compareAndSet = async (key, expected, value) => {
    if (key === 'runtime_workspace:' + h.session.id && JSON.parse(value).state === 'cleaned') { entered.resolve(); await gate.promise; }
    return cas(key, expected, value);
  };
  const cleaning = h.runtime.cleanWorkspace(h.session.id, preview.fingerprint); await entered.promise;
  let finished = false; const shutdown = h.runtime.shutdown().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false);
  gate.resolve(); await cleaning; await shutdown;
  expect(JSON.parse((await h.repos.config.get('runtime_workspace:' + h.session.id))!).state).toBe('cleaned');
  expect(existsSync(h.workspace.cwd)).toBe(false);
});

it.each(['stop', 'shutdown'] as const)('does not register a late starting workspace after %s', async action => {
  const h = await fixture(); const entered = deferred(), gate = deferred();
  fsGate.path = h.source; fsGate.entered = entered.resolve; fsGate.gate = gate.promise;
  const registrations = vi.spyOn((h.runtime as any).preparingWorkspaces, 'set');
  const prepare = vi.spyOn((h.runtime as any).workspaces, 'prepare');
  const starting = h.runtime.start({ agentId: agent.id, cwd: h.source }).catch(error => error); await entered.promise;
  const fresh = (await h.repos.sessions.list()).find(session => session.id !== h.session.id)!;
  if (action === 'stop') await h.runtime.stop(fresh.id); else await h.runtime.shutdown();
  gate.resolve(); await starting;
  expect(registrations).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
});

it('retains each preparation claim until its filesystem work settles and drains it at shutdown', async () => {
  const h = await fixture(); const manager = (h.runtime as any).workspaces;
  const prepare = manager.prepare.bind(manager);
  const firstEntered = deferred(), firstGate = deferred(), secondEntered = deferred(), secondGate = deferred();
  let calls = 0;
  manager.prepare = async (...args: unknown[]) => {
    const first = calls++ === 0;
    (first ? firstEntered : secondEntered).resolve();
    await (first ? firstGate : secondGate).promise;
    return prepare(...args);
  };
  const first = h.runtime.start({ agentId: agent.id, cwd: h.workspace.cwd }).catch(error => error);
  await firstEntered.promise;
  const firstSession = (await h.repos.sessions.list()).find(session => session.id !== h.session.id)!;
  await h.runtime.stop(firstSession.id); await h.runtime.archive(firstSession.id);
  const preview = await h.runtime.getWorkspaceCleanupPreview(h.session.id);
  expect(preview.blockers.some(blocker => blocker.code === 'WORKSPACE_PREPARING')).toBe(true);
  const second = h.runtime.start({ agentId: agent.id, cwd: h.workspace.cwd }).catch(error => error);
  await secondEntered.promise;
  const claims = (h.runtime as any).preparingWorkspaces as Map<string, Set<unknown>>;
  expect(claims.get(h.workspace.cwd)?.size).toBe(2);
  firstGate.resolve(); await first;
  // The public cancelled start can finish ahead of its observed filesystem promise.
  while (claims.get(h.workspace.cwd)?.size === 2) await new Promise(resolve => setImmediate(resolve));
  expect(claims.get(h.workspace.cwd)?.size).toBe(1);
  let closed = false; const shutdown = h.runtime.shutdown().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(closed).toBe(false);
  secondGate.resolve(); await second; await shutdown;
  expect(claims.size).toBe(0); expect(existsSync(h.workspace.cwd)).toBe(true);
});

it('drains physical workspace preparation before closing SQLite', async () => {
  const h = await fixture(false);
  const manager = (h.runtime as any).workspaces;
  const prepare = manager.prepareWorktree.bind(manager);
  const entered = deferred(), gate = deferred(), finished = deferred();
  manager.prepareWorktree = async (...args: unknown[]) => {
    entered.resolve(); await gate.promise;
    try { return await prepare(...args); } finally { finished.resolve(); }
  };
  const running = h.runtime.start({ agentId: agent.id, cwd: h.source, workspaceMode: 'worktree' }).catch(error => error);
  await entered.promise;
  const claims = (h.runtime as any).preparingWorkspaces as Map<string, Set<unknown>>;
  const protectedSource = claims.get(h.source)?.size;
  let stopped = false;
  const shutdown = h.runtime.shutdown().then(() => { stopped = true; });
  await running; await new Promise(resolve => setImmediate(resolve));
  const returnedBeforePhysicalExit = stopped;
  gate.resolve(); await finished.promise; await shutdown;
  expect(returnedBeforePhysicalExit).toBe(false);
  expect(protectedSource).toBe(1);
  expect(claims.size).toBe(0); expect((h.runtime as any).workspacePreparations.size).toBe(0);
  await h.close();
});

it('initialize and restart block unrecovered preparing workspace without starting prepareWorktree', async () => {
  const h = await fixture(false);
  await h.runtime.shutdown();
  git(h.source, 'worktree', 'remove', h.workspace.repoRoot!);
  await h.repos.config.set('runtime_workspace:' + h.session.id, JSON.stringify({ ...h.workspace, state: 'preparing', revision: h.workspace.revision + 1 }));
  const runtime = new DutydeckRuntime(h.repos, (h.runtime as any).options);
  const prepareWorktree = vi.spyOn((runtime as any).workspaces, 'prepareWorktree');
  await runtime.initialize([agent]);
  expect(prepareWorktree).not.toHaveBeenCalled();
  const blockers = (runtime as any).resourceBlockers(h.session.id);
  expect(blockers.some((b: any) => b.code === 'WORKSPACE_RECOVERY_REQUIRED')).toBe(true);

  // Restart on the same unrecovered preparing workspace is also blocked with zero prepareWorktree calls.
  await expect(runtime.restart(h.session.id)).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
  expect(prepareWorktree).not.toHaveBeenCalled();
  await runtime.shutdown();
  h.repos.close();
});
