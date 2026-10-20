import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, BoundExecutionRepository, DriverFactory, UnknownTaskResolution } from '@dutydeck/shared';
import { readFileSync } from 'node:fs';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { TerminalSnapshot } from '@dutydeck/terminal-renderer';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { DutydeckRuntime } from './index.js';

const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

/** 第一轮驱动报错后停在结果未知，第二条排在后面；idle 控制驱动是否声明自己空闲。 */
async function fixture(options: { idle?: boolean | (() => boolean); deferFailure?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-unknown-task-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  let fail = true, releaseFailure!: () => void;
  const failureGate = new Promise<void>(done => { releaseFailure = done; });
  const factory: DriverFactory = (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true,
    interrupt: async () => {}, ...(options.idle === undefined ? {} : { isIdle: () => typeof options.idle === 'function' ? options.idle() : options.idle! }), send: async input => {
      const prompt = typeof input === 'string' ? input : input.prompt; prompts.push(prompt);
      if (fail && prompt === 'original') {
        if (options.deferFailure) await failureGate;
        throw Object.assign(new Error('original result unavailable'), { code: 'AGENT_IDLE_TIMEOUT' });
      }
      emit({ type: 'text', data: { text: `done ${prompt}` } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    } });
  const agent: AgentConfig = { id: 'fixture', name: 'fixture', command: process.execPath, args: [], cwd, env: {}, protocol: 'acp', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  const first = options.deferFailure ? await runtime.dispatch(session.id, 'original') : await runtime.send(session.id, 'original');
  if (options.deferFailure) await vi.waitFor(() => expect(repos.execution.getTaskExecution(first.id)?.currentAttempt?.state).toBe('active'));
  else { expect(first.status).toBe('reconcile_required'); await vi.waitFor(() => expect(runtime.getActiveTaskContext(session.id)).toBeUndefined()); }
  const second = await runtime.dispatch(session.id, 'queued');
  const resolution = async (action: UnknownTaskResolution['action'], decisionId = `manual:${action}`, taskId = first.id): Promise<UnknownTaskResolution> => {
    const facts = await runtime.inspectUnknownTask(session.id, taskId);
    return { taskId, target: facts.target!, decisionId, action, evidenceRefs: ['operator:test', 'at:2026-10-13T00:00:00.000Z'],
      ...(action === 'completed' ? { verifiedOutputText: '已人工标为已完成' } : {}), ...(action === 'retry' ? { allowDuplicateEffects: true as const } : {}) };
  };
  const status = async (taskId: string) => (await runtime.getTasks(session.id)).find(task => task.id === taskId)?.status;
  return { repos, session, first, second, prompts, resolution, status, releaseFailure, succeed: () => { fail = false; }, get runtime() { return runtime; },
    reopen: async () => { await runtime.shutdown(); fail = false; runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 }); await runtime.initialize([agent]); } };
}

describe('resolving result-unknown tasks', () => {
  it('reports the facts a person needs before deciding', async () => {
    const h = await fixture(); await h.reopen();
    const facts = await h.runtime.inspectUnknownTask(h.session.id, h.first.id);
    const attempt = h.repos.execution.getTaskExecution(h.first.id)!.currentAttempt!;
    expect(facts).toMatchObject({ taskId: h.first.id, status: 'reconcile_required', actionable: true, kind: 'attempt', target: attempt.attemptId,
      submission: attempt.submissionState, reasonCode: 'AGENT_IDLE_TIMEOUT', startedAt: attempt.createdAt });
    expect(facts.resolution).toBeUndefined();
    expect((await h.runtime.inspectUnknownTask(h.session.id, h.second.id)).actionable).toBe(false);
  });

  it('marks failed once, records who decided, and releases the queue', async () => {
    const h = await fixture(); await h.reopen();
    const input = await h.resolution('failed', 'manual:failed:lark:ou_alice');
    await expect(h.runtime.resolveUnknownTask(h.session.id, input, { kind: 'unspecified' })).rejects.toMatchObject({ code: 'RECOVERY_OWNER_REQUIRED' });
    expect((await h.runtime.resolveUnknownTask(h.session.id, input, owner)).replayed).toBe(false);
    expect(await h.status(h.first.id)).toBe('failed');
    await vi.waitFor(async () => expect(await h.status(h.second.id)).toBe('completed'));
    const settled = h.repos.execution.getTaskExecution(h.first.id)!.currentAttempt!;
    expect(settled.settlement).toMatchObject({ kind: 'manual', outcome: 'failed', decision: { decisionId: input.decisionId, evidenceRefs: input.evidenceRefs } });
    expect((await h.runtime.inspectUnknownTask(h.session.id, h.first.id, input.target)).resolution).toMatchObject({ action: 'failed', decisionId: input.decisionId, at: settled.updatedAt });
    // 同一个决定再来（重复回调、重启后重放）只回放；别人的另一个决定被拒，不会第二次结算。
    expect((await h.runtime.resolveUnknownTask(h.session.id, input, owner)).replayed).toBe(true);
    await expect(h.runtime.resolveUnknownTask(h.session.id, { ...input, decisionId: 'manual:completed:web:owner', action: 'completed', verifiedOutputText: 'x' }, owner))
      .rejects.toMatchObject({ code: 'TASK_NOT_RESULT_UNKNOWN' });
    expect(h.prompts).toEqual(['original', 'queued']);
  });

  it('marks completed only with a verified note', async () => {
    const h = await fixture(); await h.reopen();
    const input = await h.resolution('completed');
    const { verifiedOutputText: _text, ...missing } = input;
    await expect(h.runtime.resolveUnknownTask(h.session.id, missing, owner)).rejects.toMatchObject({ code: 'RECOVERY_OUTPUT_REQUIRED' });
    await h.runtime.resolveUnknownTask(h.session.id, input, owner);
    expect(await h.status(h.first.id)).toBe('completed');
    expect(await h.runtime.getTaskRecovery(h.session.id, h.first.id)).toMatchObject({ status: 'completed', verifiedOutput: { eventId: expect.any(String) } });
  });

  it('retries the original prompt only with the duplicate-effects acknowledgement, and an old card cannot act on the new attempt', async () => {
    const h = await fixture(); await h.reopen();
    const input = await h.resolution('retry');
    const { allowDuplicateEffects: _ack, ...unacknowledged } = input;
    await expect(h.runtime.resolveUnknownTask(h.session.id, unacknowledged as UnknownTaskResolution, owner)).rejects.toThrow();
    expect(await h.status(h.first.id)).toBe('reconcile_required');
    await h.runtime.resolveUnknownTask(h.session.id, input, owner);
    await vi.waitFor(async () => expect(await h.status(h.first.id)).toBe('completed'));
    expect(h.prompts.filter(prompt => prompt === 'original')).toHaveLength(2);
    expect(h.repos.execution.getTaskExecution(h.first.id)!.attempts.map(attempt => attempt.outcome)).toEqual(['unknown', 'completed']);
    const old = await h.runtime.inspectUnknownTask(h.session.id, h.first.id, input.target);
    expect(old).toMatchObject({ actionable: false, resolution: { action: 'retry', decisionId: input.decisionId } });
    await expect(h.runtime.resolveUnknownTask(h.session.id, { ...input, decisionId: 'manual:failed:other', action: 'failed', allowDuplicateEffects: undefined }, owner))
      .rejects.toMatchObject({ code: 'TASK_NOT_RESULT_UNKNOWN' });
  });

  it('lets exactly one of two concurrent decisions settle the attempt', async () => {
    const h = await fixture(); await h.reopen();
    const [fail, complete] = [await h.resolution('failed', 'manual:failed:lark:ou_alice'), await h.resolution('completed', 'manual:completed:lark:ou_admin')];
    const results = await Promise.allSettled([h.runtime.resolveUnknownTask(h.session.id, fail, owner), h.runtime.resolveUnknownTask(h.session.id, complete, owner)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    // 先读到的一方可能同时看到「可处理」，晚提交的那个被账本版本号挡下。
    expect(['TASK_NOT_RESULT_UNKNOWN', 'ATTEMPT_REVISION_CONFLICT']).toContain((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code);
    expect(h.repos.execution.getTaskExecution(h.first.id)!.attempts).toHaveLength(1);
  });

  it('settles beside a connected driver only after it confirms it is idle', async () => {
    const busy = await fixture({ idle: false });
    await expect(busy.runtime.resolveUnknownTask(busy.session.id, await busy.resolution('failed'), owner)).rejects.toMatchObject({ code: 'RECOVERY_EXECUTION_ACTIVE' });
    expect(await busy.status(busy.first.id)).toBe('reconcile_required');

    const idle = await fixture({ idle: true });
    idle.succeed();
    await idle.runtime.resolveUnknownTask(idle.session.id, await idle.resolution('retry'), owner);
    await vi.waitFor(async () => expect(await idle.status(idle.first.id)).toBe('completed'));
    // 重新执行的原请求排在后面那条之后，仍在同一个驱动里执行。
    expect(idle.prompts).toEqual(['original', 'queued', 'original']);
  });

  it('resolves an unknown steering delivery through the steering ledger', async () => {
    const h = await fixture({ deferFailure: true });
    const bound = (h.runtime as any).bound() as BoundExecutionRepository;
    const fence = { sessionId: h.session.id, runId: h.session.runId };
    const target = h.repos.execution.getTaskExecution(h.first.id)!.currentAttempt!;
    const queued = h.repos.execution.getTaskExecution(h.second.id)!.task;
    const begun = bound.beginQueuedSteering(fence, queued.id, queued.revision, { operationId: 'steer-unknown', actor: owner, target: { taskId: target.taskId, attemptId: target.attemptId } });
    bound.resolveQueuedSteering(fence, 'steer-unknown', h.repos.execution.getTaskExecution(queued.id)!.steering!.controller, 'unknown');
    expect(begun.task?.status).toBe('reconcile_required');
    h.releaseFailure();
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(h.first.id)?.task.status).toBe('reconcile_required'));
    await h.reopen();
    const facts = await h.runtime.inspectUnknownTask(h.session.id, h.second.id);
    expect(facts).toMatchObject({ actionable: true, kind: 'steering', target: 'steer-unknown', reasonCode: 'STEERING_DELIVERY_UNKNOWN' });
    const input: UnknownTaskResolution = { taskId: h.second.id, target: 'steer-unknown', decisionId: 'manual:completed:web:owner', action: 'completed', evidenceRefs: ['operator:web:owner'] };
    await h.runtime.resolveUnknownTask(h.session.id, input, owner);
    expect(await h.status(h.second.id)).toBe('completed');
    expect((await h.runtime.inspectUnknownTask(h.session.id, h.second.id, 'steer-unknown')).resolution).toMatchObject({ action: 'completed', decisionId: input.decisionId });
    expect((await h.runtime.resolveUnknownTask(h.session.id, input, owner)).replayed).toBe(true);
  });
});

it.each(['failed', 'completed', 'retry', 'settle'] as const)('resolves %s beside a real parsed idle Claude composer and releases queued work', async action => {
  const snapshot = new TerminalSnapshot(120, 30);
  cleanups.push(async () => snapshot.dispose());
  const idleDriver = Object.assign(Object.create(PtyCliDriver.prototype), { snapshot, adapter: createCliAdapter('claude-code'), stopped: false, turnActive: false });
  const screen = readFileSync(new URL('../../cli-adapters/src/fixtures/claude-placeholder-ready/screen.txt', import.meta.url), 'utf8');
  await snapshot.writeAndFlush(screen.replaceAll('\n', '\r\n'));
  const h = await fixture({ idle: () => idleDriver.isIdle() });
  await vi.waitFor(() => expect(h.runtime.inspectAgentQuiescence(h.session.id)).not.toBe('busy'));
  expect(h.runtime.inspectAgentQuiescence(h.session.id)).toBe('idle');
  h.succeed();
  if (action === 'settle') await h.runtime.settleIdleAttempt(h.session.id, { taskId: h.first.id, decisionId: 'idle-settlement', outcome: 'failed', evidenceRefs: ['idle-screen'] }, owner);
  else await h.runtime.resolveUnknownTask(h.session.id, await h.resolution(action), owner);
  await vi.waitFor(async () => expect(await h.status(h.second.id)).toBe('completed'));
  if (action === 'retry') await vi.waitFor(async () => expect(await h.status(h.first.id)).toBe('completed'));
  else expect(await h.status(h.first.id)).toBe(action === 'settle' ? 'failed' : action);
  expect(h.prompts).toEqual(action === 'retry' ? ['original', 'queued', 'original'] : ['original', 'queued']);
});
