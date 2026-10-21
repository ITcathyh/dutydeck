import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';
import { NativeTurn } from '../../pty-driver/src/transcript/native-turn.js';
import { DutydeckRuntime, type RuntimeOptions } from './index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: RuntimeOptions = {}, alwaysCapacity = false, tools = false, unknown = false) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); const root = await mkdtemp(join(tmpdir(), 'dd-runtime-capacity-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' }); const prompts: string[] = [];
  const factory: DriverFactory = (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isIdle: () => true, isStopped: async () => true,
    send: async input => {
      prompts.push(typeof input === 'string' ? input : input.prompt);
      if (prompts.length === 1 || alwaysCapacity) {
        if (tools) emit({ type: 'tool_call', data: { id: 'side-effect', name: 'Bash', input: { command: 'business command' } } });
        const turn = new NativeTurn(true); turn.arm(new AbortController().signal);
        turn.observe({ type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${prompts.length}` } });
        turn.bind({ type: 'event_msg', payload: { type: 'user_message', turn_id: `turn-${prompts.length}`, message: 'prompt' } });
        turn.observe({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${prompts.length}`, error: { codex_error_info: 'ServerOverloaded' } } });
        emit(turn.takeError()!);
        if (unknown) throw new Error('driver return is unknown');
      } else emit({ type: 'text', data: { text: 'recovered answer' } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    } });
  const agent: AgentConfig = { id: 'codex', name: 'Codex', protocol: 'pty-cli', command: process.execPath, args: [], cwd: root, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let runtime = new DutydeckRuntime(repos, { ...options, driverFactory: factory, cleanupIntervalMs: 0 });
  cleanup.push(async () => { await runtime.shutdown(); repos.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
  return { repos, session, prompts, get runtime() { return runtime; }, reopen: async () => { await runtime.shutdown(); runtime = new DutydeckRuntime(repos, { ...options, driverFactory: factory, cleanupIntervalMs: 0 }); await runtime.initialize([agent]); } };
}
const waitRetry = async (h: Awaited<ReturnType<typeof fixture>>, taskId: string) => vi.waitFor(() => expect(h.repos.execution.getTaskExecution(taskId)?.currentAttempt?.automaticRetry).toBeDefined());
it('send waits through one durable automatic successor and returns only its completed result', async () => {
  const h = await fixture(); let result: any;
  const sent = h.runtime.send(h.session.id, 'original', 'original', undefined, 'installation_owner').then(value => { result = value; });
  await vi.waitFor(() => expect(h.prompts).toHaveLength(1)); const task = (await h.runtime.getTasks(h.session.id))[0]!;
  await waitRetry(h, task.id); expect(result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(30_100); await sent;
  expect(result.status).toBe('completed'); expect(h.prompts).toEqual(['original', 'original']);
  expect(h.repos.execution.getTaskExecution(task.id)?.attempts.map(a => a.outcome)).toEqual(['failed', 'completed']);
});
it('a new input cancels the old retry and the old request never replays', async () => {
  const h = await fixture(); const old = await h.runtime.dispatch(h.session.id, 'old', 'queue', 'old', undefined, 'installation_owner'); await waitRetry(h, old.id);
  const fresh = await h.runtime.send(h.session.id, 'new', 'new', undefined, 'installation_owner'); expect(fresh.status).toBe('completed');
  await vi.advanceTimersByTimeAsync(120_000); expect(h.prompts).toEqual(['old', 'new']);
  expect(h.repos.execution.getTaskExecution(old.id)?.currentAttempt?.outcome).toBe('cancelled');
});
it.each(['prepare', 'submit'] as const)('new input cancels a claimed automatic retry paused at %s authorization', async phase => {
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanup.push(async () => { release(); });
  const h = await fixture({ authorizeTask: async (_session, task, currentPhase) => {
    if (currentPhase === phase && h.repos.execution.getTaskExecution(task.id)?.currentAttempt?.automaticRetry) { entered = true; await gate; }
  } });
  const old = await h.runtime.dispatch(h.session.id, 'old', 'queue', 'old', undefined, 'installation_owner'); await waitRetry(h, old.id);
  await vi.advanceTimersByTimeAsync(30_100); await vi.waitFor(() => expect(entered).toBe(true));
  expect(h.repos.execution.getTaskExecution(old.id)?.currentAttempt).toMatchObject({ state: 'preparing', submissionState: 'not_submitted' });
  const fresh = await h.runtime.dispatch(h.session.id, 'new', 'queue', 'new', undefined, 'installation_owner'); release();
  await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(fresh.id)?.task.status).toBe('completed'));
  expect(h.prompts).toEqual(['old', 'new']);
  expect(h.repos.execution.getTaskExecution(old.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'cancelled', submissionState: 'not_submitted' });
});
it.each(['prepare', 'submit'] as const)('stop cancels a claimed automatic retry paused at %s authorization', async phase => {
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanup.push(async () => { release(); });
  const h = await fixture({ authorizeTask: async (_session, task, currentPhase) => {
    if (currentPhase === phase && h.repos.execution.getTaskExecution(task.id)?.currentAttempt?.automaticRetry) { entered = true; await gate; }
  } });
  const old = await h.runtime.dispatch(h.session.id, 'old', 'queue', 'old', undefined, 'installation_owner'); await waitRetry(h, old.id);
  await vi.advanceTimersByTimeAsync(30_100); await vi.waitFor(() => expect(entered).toBe(true));
  const stopping = h.runtime.stop(h.session.id, { kind: 'installation_owner', id: 'installation_owner' }); release(); await stopping;
  await vi.advanceTimersByTimeAsync(120_000); expect(h.prompts).toEqual(['old']);
  expect(h.repos.execution.getTaskExecution(old.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'cancelled', submissionState: 'not_submitted' });
});
it('rechecks the ledger CAS after a newer input arrives during the start observer', async () => {
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanup.push(async () => { release(); });
  const h = await fixture({ observeTurn: async (_session, taskId, phase) => {
    if (phase === 'start' && h.repos.execution.getTaskExecution(taskId)?.currentAttempt?.automaticRetry) { entered = true; await gate; }
  } });
  const old = await h.runtime.dispatch(h.session.id, 'old', 'queue', 'old', undefined, 'installation_owner'); await waitRetry(h, old.id);
  await vi.advanceTimersByTimeAsync(30_100); await vi.waitFor(() => expect(entered).toBe(true));
  const fresh = await h.runtime.dispatch(h.session.id, 'new', 'queue', 'new', undefined, 'installation_owner'); release();
  await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(fresh.id)?.task.status).toBe('completed'));
  expect(h.prompts).toEqual(['old', 'new']);
  expect(h.repos.execution.getTaskExecution(old.id)?.currentAttempt?.outcome).toBe('cancelled');
});
it('preserves a submitted automatic retry when new input arrives before its settlement', async () => {
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanup.push(async () => { release(); });
  const h = await fixture({ observeTurn: async (_session, taskId, phase) => {
    if (phase === 'end' && h.repos.execution.getTaskExecution(taskId)?.currentAttempt?.automaticRetry) { entered = true; await gate; }
  } });
  const old = await h.runtime.dispatch(h.session.id, 'old', 'queue', 'old', undefined, 'installation_owner'); await waitRetry(h, old.id);
  await vi.advanceTimersByTimeAsync(30_100); await vi.waitFor(() => expect(entered).toBe(true));
  const submitted = h.repos.execution.getTaskExecution(old.id)!.currentAttempt!;
  expect(submitted).toMatchObject({ state: 'active', submissionState: 'intent_recorded' });
  const fresh = await h.runtime.dispatch(h.session.id, 'new', 'queue', 'new', undefined, 'installation_owner');
  expect(h.repos.execution.getTaskExecution(old.id)?.currentAttempt).toEqual(submitted); release();
  await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(fresh.id)?.task.status).toBe('completed'));
  expect(h.prompts).toEqual(['old', 'old', 'new']); expect(h.repos.execution.getTaskExecution(old.id)?.task.status).toBe('completed');
});
it('stop cancels the delayed successor, including after restart', async () => {
  const h = await fixture(); const old = await h.runtime.dispatch(h.session.id, 'old', 'queue', 'old', undefined, 'installation_owner'); await waitRetry(h, old.id);
  await h.reopen(); await h.runtime.stop(h.session.id, { kind: 'installation_owner', id: 'installation_owner' });
  await vi.advanceTimersByTimeAsync(120_000); expect(h.prompts).toEqual(['old']); expect(h.repos.execution.getTaskExecution(old.id)?.currentAttempt?.outcome).toBe('cancelled');
});
it('rechecks original actor permission before a delayed submission', async () => {
  let permitted = true; const actors: Array<string | undefined> = [];
  const h = await fixture({ authorizeExecution: async (_session, actor) => { actors.push(actor); if (!permitted) throw new Error('permission revoked'); } });
  const old = await h.runtime.dispatch(h.session.id, 'old', 'queue', 'old', undefined, 'installation_owner'); await waitRetry(h, old.id);
  permitted = false; await vi.advanceTimersByTimeAsync(30_100);
  await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(old.id)?.task.status).toBe('failed'));
  expect(h.prompts).toEqual(['old']); expect(actors.at(-1)).toBe('installation_owner');
});
it('never replays a capacity failure after a business tool call', async () => {
  const h = await fixture({}, false, true); const task = await h.runtime.send(h.session.id, 'tool', 'tool', undefined, 'installation_owner');
  expect(task.status).toBe('failed'); await vi.advanceTimersByTimeAsync(120_000); expect(h.prompts).toEqual(['tool']);
});
it('resumes the durable deadline after restarting without replaying the settled attempt', async () => {
  const h = await fixture(); const old = await h.runtime.dispatch(h.session.id, 'old', 'queue', 'old', undefined, 'installation_owner'); await waitRetry(h, old.id);
  const original = h.repos.execution.getTaskExecution(old.id)!.attempts[0]!;
  await h.reopen(); expect(h.prompts).toEqual(['old']); await vi.advanceTimersByTimeAsync(30_100);
  await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(old.id)?.task.status).toBe('completed'));
  expect(h.prompts).toEqual(['old', 'old']); expect(h.repos.execution.getTaskExecution(old.id)?.attempts[0]).toEqual(original);
});
it('does not replay when submission has an exact capacity event but the driver never confirms completion', async () => {
  const h = await fixture({}, false, false, true); const task = await h.runtime.send(h.session.id, 'unknown', 'unknown', undefined, 'installation_owner');
  expect(task.status).toBe('reconcile_required'); await vi.advanceTimersByTimeAsync(120_000); expect(h.prompts).toEqual(['unknown']);
  expect(h.repos.execution.getTaskExecution(task.id)?.attempts).toHaveLength(1);
});
