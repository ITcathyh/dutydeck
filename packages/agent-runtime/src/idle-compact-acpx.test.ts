import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
async function fixture(mode = 'codex') {

  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-compact-acpx-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  const log = join(cwd, 'prompts.log');
  const Database = createRequire(new URL('../../storage/package.json', import.meta.url))('better-sqlite3');
  // Keep ACPX on wall clock; age only this isolated fixture's durable inactivity source.
  const ageTasks = () => {
    const database = new Database(join(cwd, 'state.db'));
    try { database.prepare("UPDATE tasks SET updated_at=? WHERE status='completed'").run(new Date(Date.now() - 25 * 3_600_000).toISOString()); }
    finally { database.close(); }
  };
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(async () => { repos.close(); });
  const agent: AgentConfig = { id: 'compact-native', name: 'Compact native', command: process.execPath, args: [resolve('packages/acp-client/tests/fixtures/compact-agent.mjs'), mode], cwd, env: { compact_test_log: log }, protocol: 'acp', permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const factory: DriverFactory = Object.assign((configured, _protocol, onEvent, onExit, sessionId, context) => new AcpxAdapter(configured, { onEvent, onExit, sessionKey: sessionId, context }), { controlledResources: () => true });
  const createRuntime = async () => {
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: factory });
    cleanup.push(() => runtime.shutdown());
    await runtime.initialize([agent]); return runtime;
  };
  return { repos, createRuntime, agent, ageTasks, prompts: async () => (await readFile(log, 'utf8')).trim().split('\n') };
}
describe('controlled real ACP native compact submission', () => {
  it('preserves native identity and execution receipts through compact before the real prompt', async () => {
    const h = await fixture(); const runtime = await h.createRuntime();
    const session = await runtime.start({ agentId: h.agent.id });
    const first = await runtime.send(session.id, 'old context'); expect(first.status).toBe('completed');
    const nativeBefore = h.repos.execution.getResources(session.id).filter(resource => resource.kind === 'native_context');
    h.ageTasks();
    const next = await runtime.dispatch(session.id, 'real task', 'queue', 'real task', undefined, undefined, undefined, undefined, undefined, 24);
    await vi.waitFor(async () => expect((await runtime.getTasks(session.id)).find(task => task.id === next.id)?.status).toBe('completed'), { timeout: 8000 });
    expect(await h.prompts()).toEqual(['old context', '/compact', 'real task']);
    expect(h.repos.execution.getResources(session.id).filter(resource => resource.kind === 'native_context').map(resource => resource.resourceId)).toEqual(nativeBefore.map(resource => resource.resourceId));
    expect(h.repos.execution.getTaskExecution(next.id)?.currentAttempt?.receipt?.kind).toBe('provider_accepted');
  });
  it('settles a confirmed compact cancellation without accepting user work and runs its queued successor', async () => {
    const h = await fixture('held'); const runtime = await h.createRuntime();
    const session = await runtime.start({ agentId: h.agent.id });
    expect((await runtime.send(session.id, 'old context')).status).toBe('completed');
    h.ageTasks();
    const interrupted = await runtime.dispatch(session.id, 'must not send', 'queue', 'must not send', undefined, undefined, undefined, undefined, undefined, 24);
    await vi.waitFor(async () => expect(await h.prompts()).toEqual(['old context', '/compact']));
    const successor = await runtime.dispatch(session.id, 'successor', 'queue', 'successor', undefined, undefined, undefined, undefined, undefined, 24);
    expect(successor.status).toBe('queued');
    await runtime.interrupt(session.id, interrupted.id);
    await vi.waitFor(async () => expect((await runtime.getTasks(session.id)).find(task => task.id === interrupted.id)?.status).toBe('interrupted'), { timeout: 8000 });
    await vi.waitFor(async () => expect((await runtime.getTasks(session.id)).find(task => task.id === successor.id)?.status).toBe('completed'), { timeout: 8000 });
    expect(await h.prompts()).toEqual(['old context', '/compact', 'successor']);
    expect(h.repos.execution.getTaskExecution(interrupted.id)?.currentAttempt?.receipt).toBeUndefined();
    expect(h.repos.execution.getTaskExecution(interrupted.id)?.currentAttempt?.settlement).toMatchObject({ kind: 'driver_result', outcome: 'interrupted', stopReason: 'cancelled' });
  });
  it('restores the same persisted native session after shutdown and reads session/load commands before compacting', async () => {
    const h = await fixture(); const firstRuntime = await h.createRuntime();
    const session = await firstRuntime.start({ agentId: h.agent.id });
    expect((await firstRuntime.send(session.id, 'old context')).status).toBe('completed');
    await firstRuntime.shutdown();
    h.ageTasks();
    const restored = await h.createRuntime();
    const next = await restored.dispatch(session.id, 'after restart', 'queue', 'after restart', undefined, undefined, undefined, undefined, undefined, 24);
    await vi.waitFor(async () => expect((await restored.getTasks(session.id)).find(task => task.id === next.id)?.status).toBe('completed'), { timeout: 8000 });
    expect(await h.prompts()).toEqual(['old context', '/compact', 'after restart']);
    expect((await restored.getSession(session.id))?.id).toBe(session.id);
  });
});
