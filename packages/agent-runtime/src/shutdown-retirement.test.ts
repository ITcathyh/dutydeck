import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(mode: 'complete' | 'active' | 'unknown') {
  const cwd = await mkdtemp(join(tmpdir(), 'shutdown-retirement-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const prepares: boolean[] = [], prompts: string[] = [];
  let release: (() => void) | undefined;
  const factory: DriverFactory = (_a, _p, emit) => {
    let preserve = true;
    return { start: async () => {}, resume: async () => {}, interrupt: async () => {},
      prepareForDaemonShutdown: value => { preserve = value; prepares.push(value); },
      stop: async () => { release?.(); }, isStopped: async () => !preserve,
      send: async input => {
        prompts.push(typeof input === 'string' ? input : input.prompt);
        if (mode === 'unknown') throw new Error('unknown provider result');
        if (mode === 'active') { await new Promise<void>(resolve => { release = resolve; }); return; }
        emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      },
    };
  };
  const agent: AgentConfig = { id: 'fake', name: 'fake', command: process.execPath, args: [], cwd, env: {}, protocol: 'acp', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 });
  cleanup.push(async () => { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
  return { repos, session, prepares, prompts, get runtime() { return runtime; }, reopen: async () => { mode = 'complete'; runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 }); await runtime.initialize([agent]); } };
}
describe('runtime shutdown persistent PTY policy', () => {
  it('stops a safe idle driver, retains queued input, and executes it once after restart', async () => {
    const h = await setup('complete'); await h.runtime.send(h.session.id, 'first');
    await vi.waitFor(() => expect(h.runtime.getActiveTaskContext(h.session.id)).toBeUndefined());
    await vi.waitFor(() => expect((h.runtime as any).recoveryInFlight(h.session.id)).toBe(false));
    // A scheduling check can leave accepted work queued while an otherwise idle driver exists.
    const scheduler = vi.spyOn(h.runtime as any, 'scheduleQueue').mockImplementation(() => {});
    const queued = await h.runtime.dispatch(h.session.id, 'after restart');
    expect(queued.status).toBe('queued'); scheduler.mockRestore(); await h.runtime.shutdown();
    expect(h.prepares).toEqual([false]);
    expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('queued');
    expect(h.repos.execution.getResources(h.session.id).find(r => r.kind === 'local_only')?.observations.at(-1)?.state).toBe('gone');
    await h.reopen();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id)).find(t => t.id === queued.id)?.status).toBe('completed'));
    expect(h.prompts).toEqual(['first', 'after restart']);
  });
  it.each(['active', 'unknown'] as const)('preserves %s execution and never replays it at restart', async mode => {
    const h = await setup(mode); const task = await h.runtime.dispatch(h.session.id, 'original');
    await vi.waitFor(() => expect(h.prompts).toEqual(['original']));
    if (mode === 'unknown') await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id))[0]?.status).toBe('reconcile_required'));
    await h.runtime.shutdown(); expect(h.prepares).toEqual([true]);
    await h.reopen();
    expect(h.prompts).toEqual(['original']);
    expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt?.state).toBe('reconcile_required');
    expect(h.repos.execution.getResources(h.session.id).find(r => r.kind === 'local_only')?.observations.at(-1)?.state).toBe('live');
  });
});
