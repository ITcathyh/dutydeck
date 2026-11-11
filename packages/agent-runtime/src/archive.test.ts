import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver, NormalizedDriverEvent } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const owner = { kind: 'installation_owner' as const, id: 'installation_owner' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(stop: 'verified' | 'unverified' | 'failed' = 'verified') {
  const directory = await mkdtemp(join(tmpdir(), 'archive-'));
  const path = join(directory, 'state.sqlite');
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  let child!: ChildProcess, exited!: Promise<unknown>, emit!: (event: NormalizedDriverEvent) => void;
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const send = vi.fn(async () => { started(); await pending; });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'jsonl', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, onEvent): AgentDriver => {
      emit = onEvent;
      return { start: async () => { child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); exited = once(child, 'exit'); await once(child, 'spawn'); },
        resume: async () => {}, interrupt: async () => {}, send,
        stop: async () => { finish(); if (stop === 'failed') throw new Error('stop failed'); if (stop === 'verified') { child.kill('SIGTERM'); await exited; } },
        isStopped: async () => child.exitCode !== null || child.signalCode !== null };
    }
  });
  const agent: AgentConfig = { id: 'archive-fixture', name: 'Archive fixture', command: 'unused', args: [], protocol: 'jsonl', cwd: directory, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let closed = false;
  const close = async () => { if (!closed) { closed = true; finish(); if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await runtime.shutdown(); repos.close(); } };
  cleanups.push(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  const active = await runtime.dispatch(session.id, 'active', 'queue', 'active', undefined, owner.id);
  await entered;
  const queued = await runtime.dispatch(session.id, 'queued', 'queue', 'queued', undefined, owner.id);
  return { runtime, repos, path, agent, session, active, queued, send, close, finish, emit: (event: NormalizedDriverEvent) => emit(event) };
}

it('archives a physically stopped turn with unknown effects, ignores late receipts, and keeps it archived after restart', async () => {
  const h = await fixture();
  const archived = await h.runtime.archive(h.session.id, owner);
  expect(archived).toMatchObject({ state: 'stopped', archivedAt: expect.any(String) });
  const projection = h.repos.execution.getTaskExecution(h.active.id)!;
  expect(projection.task.status).toBe('reconcile_required');
  expect(projection.currentAttempt).toMatchObject({ state: 'settled', outcome: 'unknown', settlement: { kind: 'manual', decision: { actor: owner, action: 'confirm_result', evidenceRefs: ['session_archive_after_verified_stop'] } } });
  expect(h.repos.execution.getTaskExecution(h.queued.id)?.task.status).toBe('cancelled');
  expect(h.send).toHaveBeenCalledOnce();
  const events = await h.runtime.getEvents(h.session.id);
  h.emit({ type: 'text', data: { text: 'late text' } });
  h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(h.repos.execution.getTaskExecution(h.active.id)).toEqual(projection);
  expect(await h.runtime.getEvents(h.session.id)).toEqual(events);
  await h.close();
  const repos = createRepositories(h.path);
  const factory = vi.fn();
  const recovered = new DutydeckRuntime(repos, { driverFactory: factory });
  try {
    await recovered.initialize([h.agent]);
    expect(await recovered.getSession(h.session.id)).toMatchObject({ archivedAt: archived.archivedAt, state: 'stopped', runId: h.session.runId });
    expect(repos.execution.getTaskExecution(h.active.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'unknown' });
    expect(repos.execution.getTaskExecution(h.queued.id)?.task.status).toBe('cancelled');
    expect(factory).not.toHaveBeenCalled();
    await expect(recovered.dispatch(h.session.id, 'must not replay')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' });
  } finally { await recovered.shutdown(); repos.close(); }
});

it.each(['unverified', 'failed'] as const)('refuses archival when physical stop is %s and preserves the unsettled result', async stop => {
  const h = await fixture(stop);
  await expect(h.runtime.archive(h.session.id, owner)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
  expect((await h.runtime.getSession(h.session.id))?.archivedAt).toBeFalsy();
  expect(h.repos.execution.getTaskExecution(h.active.id)?.currentAttempt).toMatchObject({ state: 'reconcile_required', reconcileReason: { code: 'STOP_RESULT_UNKNOWN' } });
  expect(h.repos.execution.getTaskExecution(h.active.id)?.currentAttempt?.settlement).toBeUndefined();
  expect(h.repos.execution.getTaskExecution(h.queued.id)?.task.status).toBe('cancelled');
  expect(h.send).toHaveBeenCalledOnce();
});

it('does not settle a result that was already unknown before the archive request', async () => {
  const h = await fixture();
  await h.runtime.stop(h.session.id, owner);
  await expect(h.runtime.archive(h.session.id, owner)).rejects.toMatchObject({ code: 'SESSION_PENDING_ATTEMPTS' });
  expect((await h.runtime.getSession(h.session.id))?.archivedAt).toBeFalsy();
  expect(h.repos.execution.getTaskExecution(h.active.id)?.currentAttempt).toMatchObject({ state: 'reconcile_required' });
});

it('lets a newer transition revoke archival before the unknown-result settlement', async () => {
  const h = await fixture();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inspect = h.runtime.inspectExecutionRecovery.bind(h.runtime);
  vi.spyOn(h.runtime, 'inspectExecutionRecovery').mockImplementation(async (...args) => { entered(); await gate; return inspect(...args); });
  const archival = h.runtime.archive(h.session.id, owner).catch(error => error);
  try {
    await ready;
    await h.runtime.stop(h.session.id, owner);
    release();
    expect(await archival).toMatchObject({ code: 'OPERATION_REVOKED' });
    expect((await h.runtime.getSession(h.session.id))?.archivedAt).toBeFalsy();
    expect(h.repos.execution.getTaskExecution(h.active.id)?.currentAttempt).toMatchObject({ state: 'reconcile_required' });
  } finally { release(); await archival; }
});
