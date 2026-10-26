import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, type WorkPlan } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { NativeTurn } from '../../../packages/pty-driver/src/transcript/native-turn.js';
import { WorkItemService } from './work-items.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;
const plan = (ids = ['a', 'b', 'c']): WorkPlan => ({ title: 'Recovery', steps: ids.map((id, index) => ({ id, title: id, kind: 'agent', agentId: 'codex', instruction: `Execute ${id}`, dependsOn: index ? [ids[index - 1]!] : [] })), outputStepId: ids.at(-1)! });
async function fixture(mode: 'capacity' | 'exhausted' | 'unknown' = 'unknown', workPlan = plan(), failureGate?: Promise<void>) {
  if (mode !== 'unknown') vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const directory = await mkdtemp(join(tmpdir(), 'work-recovery-'));
  const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  const counts: Record<string, number> = {};
  let permitted = true, agentsPermitted = true;
  let service!: WorkItemService;
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0, workspaceRoot: join(directory, 'workspaces'),
    probe: () => ({ available: true, protocol: mode === 'unknown' ? 'jsonl' : 'pty-cli', pause: false, resume: true }),
    authorizeExecution: async (id, actor) => { await service.authorizeExecution(id, actor); },
    authorizeControl: async (id, actor) => { await service.authorizeControl(id, actor); },
    authorizeTask: (session, task, phase) => service.authorizeTask(session, task, phase),
    driverFactory: (_agent, _protocol, emit) => {
      let stopped = false, busy = false;
      return {
        start: async () => {}, resume: async () => {}, interrupt: async () => {},
        stop: async () => { stopped = true; }, isStopped: async () => stopped, isIdle: () => !busy, hasBackgroundWork: () => false,
        send: async input => {
          busy = true;
          try {
            const prompt = typeof input === 'string' ? input : input.prompt;
            prompts.push(prompt);
            const id = prompt.match(/Step: (\w+)/)?.[1] ?? 'unknown';
            counts[id] = (counts[id] ?? 0) + 1;
            if (mode === 'unknown' && id !== 'a' && counts[id] === 1) {
              emit({ type: 'text', data: { text: `partial ${id}` } });
              await failureGate;
              throw new Error('fixture response lost');
            }
            if (id === 'a' && (mode === 'exhausted' || mode === 'capacity' && counts[id] === 1)) {
              const turn = new NativeTurn(true); turn.arm(new AbortController().signal);
              const turnId = `capacity-${counts[id]}`;
              turn.observe({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } });
              turn.bind({ type: 'event_msg', payload: { type: 'user_message', turn_id: turnId, message: prompt } });
              turn.observe({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, error: { codex_error_info: 'ServerOverloaded' } } });
              emit(turn.takeError()!);
            } else emit({ type: 'text', data: { text: `answer ${id}` } });
            emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          } finally { busy = false; }
        }
      };
    }
  });
  const deliveries = vi.fn(async () => {});
  const makeService = () => new WorkItemService({ repositories: repos, runtime, authorize: async () => permitted, authorizeAgent: async () => agentsPermitted, deliver: deliveries });
  service = makeService();
  cleanup.push(async () => { await service.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const agent = agentConfigSchema.parse({ id: 'codex', name: 'fixture', command: 'unused', protocol: mode === 'unknown' ? 'jsonl' : 'pty-cli', cwd: directory, permissionMode: 'ask' });
  await runtime.initialize([agent]);
  const parent = await runtime.start({ agentId: agent.id, cwd: directory });
  const item = await service.create(parent.id, { goal: 'Recover only verified original work', idempotencyKey: 'recovery', plan: workPlan }, owner.id);
  const get = () => service.get(parent.id, item.id, owner.id);
  const raw = async () => JSON.parse((await repos.config.get('work_item:' + item.id))!);
  const wait = async (check: () => boolean | Promise<boolean>, tick = true) => {
    await vi.waitFor(async () => { if (tick) await service.tick(); expect(await check()).toBe(true); }, { timeout: 2500, interval: 10 });
  };
  const confirm = async (stepId = 'b', outcome: 'completed' | 'failed' | 'unknown' = 'completed') => {
    const attempt = (await get()).steps.find(step => step.id === stepId)!.attempts.at(-1)!;
    const snapshot = await runtime.inspectExecutionRecovery(attempt.sessionId!, owner);
    const original = repos.execution.getTaskExecution(attempt.taskId!)!.currentAttempt!;
    await runtime.confirmExecutionRecovery(attempt.sessionId!, {
      runId: snapshot.runId, taskId: attempt.taskId!, attemptId: original.attemptId, expectedRevision: original.revision,
      decisionId: `confirm-${stepId}-${outcome}`, evidenceRefs: ['fixture:inspected-original'], resourceChecks: snapshot.resourceChecks,
      action: 'confirm_result', outcome, ...(outcome === 'completed' ? { verifiedOutputText: `verified ${stepId}` } : {})
    }, owner);
    return original.attemptId;
  };
  return { repos, runtime, get service() { return service; }, parent, item, get, raw, wait, confirm, counts, prompts, deliveries,
    revoke: () => { permitted = false; }, revokeAgent: () => { agentsPermitted = false; },
    recreate: async () => { await service.close(); service = makeService(); }
  };
}

describe('WorkItem capacity and confirmed recovery with real Runtime and SQLite', () => {
  it('waits for a verified capacity successor, freezes its provenance and advances downstream once', async () => {
    const f = await fixture('capacity', plan(['a', 'b']));
    await f.wait(async () => !!(await f.get()).steps[0]!.attempts[0]?.taskId);
    const taskId = (await f.get()).steps[0]!.attempts[0]!.taskId!;
    await f.wait(() => !!f.repos.execution.getTaskExecution(taskId)?.currentAttempt?.automaticRetry);
    expect((await f.get()).status).toBe('running');
    expect(f.repos.execution.getTaskExecution(taskId)!.currentAttempt!.state).toBe('suspended');
    await vi.advanceTimersByTimeAsync(30_100);
    await f.wait(async () => (await f.get()).status === 'completed');
    const done = await f.get(), attempt = done.steps[0]!.attempts[0]!;
    const execution = f.repos.execution.getTaskExecution(taskId)!;
    expect(attempt.runtimeAttemptId).toBe(execution.attempts[0]!.attemptId);
    expect(attempt.result).toMatchObject({ attemptId: execution.attempts[1]!.attemptId, output: { text: 'answer a' } });
    expect(f.prompts.at(-1)).toContain('answer a');
    expect(f.counts).toEqual({ a: 2, b: 1 });
    await f.wait(() => f.deliveries.mock.calls.length === 1, false);
    await f.recreate(); await f.service.tick(); await f.service.tick();
    expect(f.counts).toEqual({ a: 2, b: 1 }); expect(f.deliveries).toHaveBeenCalledTimes(1);
  });

  it('settles exhausted capacity retries as failed without dispatching descendants', async () => {
    const f = await fixture('exhausted', plan(['a', 'b']));
    await f.wait(async () => f.counts.a === 1 && (await f.get()).status === 'running');
    await vi.advanceTimersByTimeAsync(30_100);
    await f.wait(() => f.counts.a === 2);
    await vi.advanceTimersByTimeAsync(90_100);
    await f.wait(async () => (await f.get()).status === 'failed');
    const failed = await f.get();
    expect(f.counts).toEqual({ a: 3 }); expect(failed.steps[0]!.status).toBe('failed');
    expect(failed.steps[1]!.attempts).toHaveLength(0); expect(f.deliveries).not.toHaveBeenCalled();
  });

  it('accepts confirmed original success and keeps previously successful steps and deliveries single', async () => {
    const f = await fixture('unknown', plan(['a', 'b', 'c']));
    await f.wait(async () => (await f.get()).status === 'blocked');
    const first = (await f.get()).steps[0]!.attempts[0]!.result;
    await f.confirm('b');
    await f.wait(async () => (await f.get()).steps[2]!.status === 'blocked');
    expect((await f.get()).steps[0]!.attempts[0]!.result).toEqual(first);
    expect(f.counts).toEqual({ a: 1, b: 1, c: 1 });
    expect(f.prompts.at(-1)).toContain('verified b'); expect(f.prompts.at(-1)).not.toContain('partial b');
    await f.confirm('c');
    await f.wait(async () => (await f.get()).status === 'completed');
    await f.wait(() => f.deliveries.mock.calls.length === 1, false);
    await f.recreate(); await f.service.tick(); await f.service.tick();
    expect(f.counts).toEqual({ a: 1, b: 1, c: 1 }); expect(f.deliveries).toHaveBeenCalledTimes(1);
  });

  it('makes confirmed original failure explicitly retryable and leaves unresolved results blocked', async () => {
    const f = await fixture('unknown', plan(['a', 'b']));
    await f.wait(async () => (await f.get()).status === 'blocked');
    await f.service.tick(); expect((await f.get()).status).toBe('blocked');
    await f.confirm('b', 'failed'); await f.service.tick();
    const failed = await f.get(); expect(failed.status).toBe('failed'); expect(failed.steps[1]!.status).toBe('failed');
    await f.service.retryStep(f.parent.id, f.item.id, 'b', failed.revision, owner.id);
    await f.wait(async () => (await f.get()).status === 'completed');
    expect(f.counts).toEqual({ a: 1, b: 2 });
  });

  it('keeps a confirmed unknown original blocked', async () => {
    const f = await fixture('unknown', plan(['a', 'b']));
    await f.wait(async () => (await f.get()).status === 'blocked');
    await f.confirm('b', 'unknown'); await f.service.tick(); await f.service.tick();
    expect((await f.get()).status).toBe('blocked'); expect(f.counts).toEqual({ a: 1, b: 1 });
  });

  it.each(['admission', 'attempt anchor'] as const)('rejects confirmed output when its fixed %s is replaced', async field => {
    const f = await fixture('unknown', plan(['a', 'b', 'c']));
    await f.wait(async () => (await f.get()).status === 'blocked');
    await f.confirm('b');
    const record = await f.raw(), attempt = record.item.steps[1].attempts[0];
    if (field === 'admission') record.admissions[attempt.id].request.prompt = 'replacement request';
    else attempt.runtimeAttemptId = 'replacement-attempt';
    await f.repos.config.set('work_item:' + f.item.id, JSON.stringify(record));
    await f.service.tick(); await f.service.tick();
    expect((await f.get()).status).toBe('blocked'); expect(f.counts).toEqual({ a: 1, b: 1 });
    expect((await f.get()).steps[2]!.attempts).toHaveLength(0); expect(f.deliveries).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'unresolved cancellation', 'authorization', 'agent authorization'] as const)('does not resurrect confirmed work after %s', async guard => {
    const f = await fixture('unknown', plan(['a', 'b', 'c']));
    await f.wait(async () => (await f.get()).status === 'blocked');
    await f.confirm('b');
    if (guard === 'cancel' || guard === 'unresolved cancellation') {
      if (guard === 'unresolved cancellation') {
        const record = await f.raw(); record.stoppedAttempts = [];
        await f.repos.config.set('work_item:' + f.item.id, JSON.stringify(record));
        vi.spyOn(f.runtime, 'stopWorkItemSession').mockResolvedValueOnce(false);
      }
      const blocked = await f.get(); await f.service.cancel(f.parent.id, f.item.id, blocked.revision, owner.id);
      if (guard === 'unresolved cancellation') {
        const record = await f.raw(); delete record.cancellationActor;
        await f.repos.config.set('work_item:' + f.item.id, JSON.stringify(record));
      }
    }
    else if (guard === 'authorization') f.revoke(); else f.revokeAgent();
    await f.service.tick(); await f.service.tick();
    const stored = (await f.raw()).item;
    expect(stored.status).toBe(guard === 'cancel' ? 'cancelled' : 'blocked');
    expect(stored.steps[2].attempts).toHaveLength(0); expect(f.counts).toEqual({ a: 1, b: 1 }); expect(f.deliveries).not.toHaveBeenCalled();
  });

  it.each(['admission', 'stop proof', 'cancel', 'authorization', 'agent authorization'] as const)('does not restart an unsubmitted sibling after %s fails', async guard => {
    const parallel = plan(['a', 'b', 'c']);
    parallel.steps[1]!.dependsOn = []; parallel.steps[2]!.dependsOn = [];
    parallel.steps.push({ id: 'd', title: 'd', kind: 'agent', agentId: 'codex', instruction: 'Execute d', dependsOn: ['a', 'b', 'c'] });
    parallel.outputStepId = 'd';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture('unknown', parallel, gate);
    cleanup.push(async () => release());
    await f.wait(() => f.counts.b === 1);
    const record = await f.raw(), sibling = record.item.steps.find((step: { id: string }) => step.id === 'c').attempts[0];
    if (guard === 'admission') {
      record.admissions[sibling.id].request.prompt = 'different frozen request';
      await f.repos.config.set('work_item:' + f.item.id, JSON.stringify(record));
    } else if (guard === 'stop proof') {
      const stop = f.runtime.stopWorkItemSession.bind(f.runtime);
      vi.spyOn(f.runtime, 'stopWorkItemSession').mockImplementation((id, actor) => id === sibling.sessionId ? Promise.resolve(false) : stop(id, actor));
    }
    release();
    await f.wait(async () => (await f.get()).status === 'blocked');
    await f.confirm('b');
    if (guard === 'cancel') {
      const item = await f.get(); await f.service.cancel(f.parent.id, item.id, item.revision, owner.id);
    } else if (guard === 'authorization') f.revoke();
    else if (guard === 'agent authorization') f.revokeAgent();
    await f.service.tick(); await f.service.tick();
    const stored = (await f.raw()).item;
    expect(stored.status).toBe(guard === 'cancel' ? 'cancelled' : 'blocked');
    expect(stored.steps.find((step: { id: string }) => step.id === 'c').attempts).toHaveLength(1);
    expect(f.counts).toEqual({ a: 1, b: 1 });
    expect(f.deliveries).not.toHaveBeenCalled();
  });

  it('serializes same-workspace branches and requires each unknown result confirmed before progressing', async () => {
    const parallel = plan(['a', 'b', 'c']); parallel.steps[1]!.dependsOn = []; parallel.steps[2]!.dependsOn = [];
    parallel.steps.push({ id: 'd', title: 'd', kind: 'agent', agentId: 'codex', instruction: 'Execute d', dependsOn: ['a', 'b', 'c'] }); parallel.outputStepId = 'd';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture('unknown', parallel, gate);
    cleanup.push(async () => { release(); });
    await f.wait(() => f.counts.b === 1);
    expect(f.counts.c).toBeUndefined();
    release();
    await f.wait(async () => (await f.get()).steps.find(step => step.id === 'b')!.status === 'blocked');
    expect(f.counts.c).toBeUndefined(); expect(f.counts.d).toBeUndefined();
    const cancelled = (await f.get()).steps.find(step => step.id === 'c')!.attempts[0]!;
    expect(cancelled.status).toBe('cancelled');
    expect(f.repos.execution.getTaskExecution(cancelled.taskId!)!).toMatchObject({ task: { status: 'cancelled' }, attempts: [] });
    await f.confirm('b');
    await f.wait(() => f.counts.c === 1);
    const retried = (await f.get()).steps.find(step => step.id === 'c')!;
    expect(retried.attempts).toHaveLength(2);
    expect(retried.attempts[1]!.number).toBe(2);
    expect(retried.attempts[1]!.taskId).not.toBe(cancelled.taskId);
    expect(f.repos.execution.getTaskExecution(cancelled.taskId!)!).toMatchObject({ task: { status: 'cancelled' }, attempts: [] });
    await f.wait(async () => (await f.get()).steps.find(step => step.id === 'c')!.status === 'blocked');
    expect((await f.get()).steps.find(step => step.id === 'b')!.status).toBe('completed'); expect(f.counts.d).toBeUndefined();
    await f.confirm('c');
    await f.wait(async () => (await f.get()).steps.find(step => step.id === 'd')!.status === 'blocked');
    expect(f.counts).toEqual({ a: 1, b: 1, c: 1, d: 1 });
  });
});
