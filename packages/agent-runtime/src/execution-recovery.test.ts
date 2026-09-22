import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory, ExecutionRecoveryDecision, BoundExecutionRepository } from '@dutydeck/shared';
import { DutydeckRuntime, type RuntimeOptions, type PtyRetirementControl } from './index.js';
const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(options: RuntimeOptions = {}, isStopped = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-recovery-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const prompts: string[] = [];
  let fail = true;
  const factory: DriverFactory = (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => isStopped,
    interrupt: async () => {}, send: async input => {
      const prompt = typeof input === 'string' ? input : input.prompt; prompts.push(prompt);
      if (fail) throw Object.assign(new Error('original result unavailable'), { code: 'AGENT_IDLE_TIMEOUT' });
      emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    } });
  const agent: AgentConfig = { id: 'fixture', name: 'fixture', command: process.execPath, args: [], cwd, env: {}, protocol: 'acp', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  let runtime = new DutydeckRuntime(repos, { ...options, driverFactory: factory, cleanupIntervalMs: 0 });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  const first = await runtime.send(session.id, 'original');
  expect(first.status).toBe('reconcile_required');
  await vi.waitFor(() => expect(runtime.getActiveTaskContext(session.id)).toBeUndefined());
  const second = await runtime.dispatch(session.id, 'queued');
  const decision = async (decisionId = 'confirmed'): Promise<ExecutionRecoveryDecision> => {
    const snapshot = await runtime.inspectExecutionRecovery(session.id, owner);
    const attempt = snapshot.tasks.find(task => task.taskId === first.id)!.attempt!;
    return { runId: snapshot.runId, taskId: first.id, attemptId: attempt.attemptId, expectedRevision: attempt.revision,
      decisionId, action: 'confirm_result', outcome: 'unknown', evidenceRefs: ['operator:original-result-unknown'], resourceChecks: snapshot.resourceChecks };
  };
  return { repos, session, first, second, prompts, decision, get runtime() { return runtime; },
    reopen: async () => { await runtime.shutdown(); fail = false; runtime = new DutydeckRuntime(repos, { ...options, driverFactory: factory, cleanupIntervalMs: 0 }); await runtime.initialize([agent]); } };
}
describe('owner execution recovery', () => {
  it('rejects unauthorized, stale and live-resource confirmation without changing the original attempt', async () => {
    const h = await fixture();
    const input = await h.decision();
    await expect(h.runtime.confirmExecutionRecovery(h.session.id, input, { kind: 'unspecified' })).rejects.toMatchObject({ code: 'RECOVERY_OWNER_REQUIRED' });
    await expect(h.runtime.confirmExecutionRecovery(h.session.id, { ...input, expectedRevision: input.expectedRevision + 1 }, owner)).rejects.toMatchObject({ code: 'ATTEMPT_REVISION_CONFLICT' });
    await expect(h.runtime.confirmExecutionRecovery(h.session.id, input, owner)).rejects.toMatchObject({ code: 'SESSION_RESOURCE_BLOCKED' });
    expect(h.repos.execution.getTaskExecution(h.first.id)?.currentAttempt?.reconcileReason?.code).toBe('AGENT_IDLE_TIMEOUT');
    await expect(h.runtime.replaceNativeContext(h.session.id, owner, 'native', 1, 'replace', 'stale-run')).rejects.toMatchObject({ code: 'SESSION_RUN_CONFLICT' });
    expect(h.prompts).toEqual(['original']);
  });
  it('confirms unknown with physical stop evidence and releases queued work once across repeated decisions', async () => {
    const h = await fixture(); await h.reopen();
    const input = await h.decision();
    const stale = input.resourceChecks.map(check => ({ ...check, expectedRevision: check.expectedRevision - 1 }));
    await expect(h.runtime.confirmExecutionRecovery(h.session.id, { ...input, resourceChecks: stale }, owner)).rejects.toMatchObject({ code: 'RESOURCE_OBSERVATION_CONFLICT' });
    expect((await h.runtime.getTaskRecovery(h.session.id, h.second.id)).blockers).toContainEqual({ code: 'PREVIOUS_RESULT_UNKNOWN' });
    const first = await h.runtime.confirmExecutionRecovery(h.session.id, input, owner);
    expect(first.replayed).toBe(false);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id)).find(task => task.id === h.second.id)?.status).toBe('completed'));
    const replay = await h.runtime.confirmExecutionRecovery(h.session.id, input, owner);
    expect(replay.replayed).toBe(true);
    expect(h.prompts).toEqual(['original', 'queued']);
    expect(await h.runtime.getTaskRecovery(h.session.id, h.first.id)).toMatchObject({ status: 'reconcile_required', resolvedUnknown: true });
    expect((await h.runtime.getTaskRecovery(h.session.id, h.second.id)).blockers).not.toContainEqual({ code: 'PREVIOUS_RESULT_UNKNOWN' });
    await expect(h.runtime.confirmExecutionRecovery(h.session.id, { ...input, outcome: 'completed', verifiedOutputText: 'verified result' }, owner)).rejects.toMatchObject({ code: 'EXECUTION_OPERATION_CONFLICT' });
  });
  it('requires verified output for completed recovery and projects only settlement-owned digest metadata', async () => {
    const h = await fixture(); await h.reopen(); const base = await h.decision('result');
    await expect(h.runtime.confirmExecutionRecovery(h.session.id, { ...base, outcome: 'completed' }, owner)).rejects.toThrow();
    await h.runtime.confirmExecutionRecovery(h.session.id, { ...base, outcome: 'completed', verifiedOutputText: 'verified original answer' }, owner);
    const recovery = await h.runtime.getTaskRecovery(h.session.id, h.first.id);
    const attempt = h.repos.execution.getTaskExecution(h.first.id)!.currentAttempt!;
    expect(attempt.settlement?.kind).toBe('manual');
    expect(recovery).toMatchObject({ status: 'completed', resolvedUnknown: false, verifiedOutput: { eventId: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const event = h.repos.execution.getAttemptEvents(attempt.attemptId).find(event => event.id === recovery.verifiedOutput!.eventId)!;
    expect(event).toMatchObject({ settlementId: 'recovery:result', data: { text: 'verified original answer', recovery: { actor: owner } } });
  });
  it('retries only after explicit duplicate-effects acknowledgement and preserves the original unknown result', async () => {
    const h = await fixture(); await h.reopen(); const base = await h.decision('retry');
    const { outcome: _outcome, ...scope } = base as Extract<ExecutionRecoveryDecision, { action: 'confirm_result' }>;
    await expect(h.runtime.confirmExecutionRecovery(h.session.id, { ...scope, action: 'retry' } as any, owner)).rejects.toThrow();
    const input = { ...scope, action: 'retry' as const, allowDuplicateEffects: true as const };
    await h.runtime.confirmExecutionRecovery(h.session.id, input, owner);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(h.session.id)).find(task => task.id === h.first.id)?.status).toBe('completed'));
    await h.runtime.confirmExecutionRecovery(h.session.id, input, owner);
    expect(h.prompts.filter(prompt => prompt === 'original')).toHaveLength(2);
    expect(h.repos.execution.getTaskExecution(h.first.id)?.attempts.map(attempt => attempt.outcome)).toEqual(['unknown', 'completed']);
  });
  it('does not clear a local-only live stop block by probing or guessing that an idle session is safe', async () => {
    const h = await fixture();
    const raw = JSON.stringify({ sessionId: h.session.id, runId: h.session.runId, reason: 'unverified' });
    await h.repos.config.set(`runtime_driver_stop_block:${h.session.id}`, raw);
    const snapshot = await h.runtime.probeExecutionRecovery(h.session.id, h.session.runId, owner);
    expect(snapshot.stopBlock).toBe(raw);
    expect(snapshot.unverifiedResourceIds.length).toBeGreaterThan(0);
    expect(h.prompts).toEqual(['original']);
  });
});


describe('trusted explicit PTY retirement', () => {
  const inputFor = async (h: Awaited<ReturnType<typeof fixture>>, decisionId = 'retire') => {
    await vi.waitFor(() => expect((h.runtime as any).drains.size).toBe(0));
    const r = (await h.runtime.inspectExecutionRecovery(h.session.id, owner)).resources.find(r => r.kind === 'local_only')!;
    return { runId: h.session.runId, resourceId: r.resourceId, expectedRevision: r.revision, decisionId, evidenceRefs: ['operator:exact-owner-reviewed'] };
  };
  it('persists the pre-kill identity and resumes after exit-before-observation interruption without a second stop', async () => {
    let gone = false;
    const capture = vi.fn(() => ({ identities: ['original'] }));
    const stop = vi.fn<PtyRetirementControl['stop']>(async (_session, _snapshot, beforeKill) => { await beforeKill({ identities: ['original', 'late-descendant'] }); gone = true; throw new Error('crashed after kill before observation'); });
    const h = await fixture({ ptyRetirement: { capture, stop, verify: (_session, snapshot) => gone && (snapshot as any).identities.includes('late-descendant') } }, false);
    const input = await inputFor(h);
    await expect(h.runtime.retirePtyExecution(h.session.id, { ...input, expectedRevision: input.expectedRevision + 1 }, owner)).rejects.toMatchObject({ code: 'RESOURCE_REVISION_CONFLICT' });
    await expect(h.runtime.retirePtyExecution(h.session.id, input, { kind: 'unspecified' })).rejects.toMatchObject({ code: 'RECOVERY_OWNER_REQUIRED' });
    expect(capture).not.toHaveBeenCalled();
    await expect(h.runtime.retirePtyExecution(h.session.id, input, owner)).rejects.toThrow('crashed after kill');
    expect(JSON.parse((await h.repos.config.get(`runtime_pty_retirement:${h.session.id}:retire`))!).snapshot).toEqual({ identities: ['original', 'late-descendant'] });
    expect((await h.runtime.inspectExecutionRecovery(h.session.id, owner)).stopBlock).not.toBeNull();
    await h.reopen();
    await expect(h.runtime.retirePtyExecution(h.session.id, { ...input, evidenceRefs: ['changed'] }, owner)).rejects.toMatchObject({ code: 'EXECUTION_OPERATION_CONFLICT' });
    await h.runtime.retirePtyExecution(h.session.id, input, owner);
    const repeat = await h.runtime.retirePtyExecution(h.session.id, input, owner);
    expect(repeat.replayed).toBe(true); expect(stop).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(1);
    const resource = repeat.recovery.resources.find(r => r.resourceId === input.resourceId)!;
    expect(resource.observations.filter(o => o.state === 'gone')).toHaveLength(1);
    const bound = (h.runtime as any).bound() as BoundExecutionRepository, fence = { sessionId: h.session.id, runId: input.runId };
    let next = bound.beforeCreate(fence, { resourceId: 'new-generation', kind: 'local_only' });
    next = bound.spawned(fence, next.resourceId, next.revision, { identityId: 'new-identity', kind: 'local_only', locator: { owner: 'runtime-adapter' } });
    next = bound.creationFinished(fence, next.resourceId, next.revision, 'created');
    bound.observed(fence, next.resourceId, next.revision, { observationId: 'new-live', identityId: 'new-identity', state: 'live', evidenceRef: 'new-driver-start', observedAt: new Date().toISOString() });
    const newBlock = JSON.stringify({ ...fence, reason: 'new generation unverified' });
    await h.repos.config.set(`runtime_driver_stop_block:${h.session.id}`, newBlock);
    (h.runtime as any).activeTurns.add(h.session.id);
    try { expect((await h.runtime.retirePtyExecution(h.session.id, input, owner)).replayed).toBe(true); }
    finally { (h.runtime as any).activeTurns.delete(h.session.id); }
    expect(await h.repos.config.get(`runtime_driver_stop_block:${h.session.id}`)).toBe(newBlock);
    expect(capture).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1);
    expect((await h.runtime.getTaskRecovery(h.session.id, h.first.id)).resolvedUnknown).toBe(false);
    expect(h.prompts).toEqual(['original']);
  });
  it('rejects a historical gone resource and ambiguous live resources without touching the current PTY', async () => {
    const capture = vi.fn(() => ({ original: true })), stop = vi.fn<PtyRetirementControl['stop']>(async (_s, snapshot) => snapshot);
    const h = await fixture({ ptyRetirement: { capture, stop, verify: () => false } }, false);
    const input = await inputFor(h), bound = (h.runtime as any).bound() as BoundExecutionRepository;
    const fence = { sessionId: h.session.id, runId: h.session.runId };
    let second = bound.beforeCreate(fence, { resourceId: 'second-pty', kind: 'local_only' });
    second = bound.spawned(fence, second.resourceId, second.revision, { identityId: 'second-generation', kind: 'local_only', locator: { owner: 'runtime-adapter' } });
    second = bound.creationFinished(fence, second.resourceId, second.revision, 'created');
    second = bound.observed(fence, second.resourceId, second.revision, { observationId: 'second-live', state: 'live', identityId: 'second-generation', evidenceRef: 'original-start', observedAt: new Date().toISOString() });
    await expect(h.runtime.retirePtyExecution(h.session.id, input, owner)).rejects.toMatchObject({ code: 'PTY_RETIREMENT_RESOURCE_AMBIGUOUS' });
    const original = h.repos.execution.getResources(h.session.id).find(r => r.resourceId === input.resourceId)!;
    const gone = bound.observed(fence, original.resourceId, original.revision, { observationId: 'old-gone', state: 'gone', identityId: original.identity!.identityId, evidenceRef: 'original-stop', observedAt: new Date().toISOString() });
    await expect(h.runtime.retirePtyExecution(h.session.id, { ...input, expectedRevision: gone.revision }, owner)).rejects.toMatchObject({ code: 'PTY_RETIREMENT_RESOURCE_UNSAFE' });
    expect(capture).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    expect(h.repos.execution.getResources(h.session.id).find(r => r.resourceId === second.resourceId)?.observations.at(-1)?.state).toBe('live');
  });
  it('blocks concurrent queue start and requires a separate unknown confirmation before dispatch', async () => {
    let release!: () => void, entered!: () => void, gone = false;
    const enteredStop = new Promise<void>(resolve => { entered = resolve; });
    const stopGate = new Promise<void>(resolve => { release = resolve; });
    const h = await fixture({ ptyRetirement: { capture: () => ({ original: true }), verify: () => gone, stop: async (_s, snapshot, beforeKill) => { await beforeKill(snapshot); entered(); await stopGate; gone = true; return snapshot; } } }, false);
    const input = await inputFor(h); const pending = h.runtime.retirePtyExecution(h.session.id, input, owner); await enteredStop;
    const third = await h.runtime.dispatch(h.session.id, 'concurrent queued');
    expect(third.status).toBe('queued'); expect(h.prompts).toEqual(['original']);
    await expect(h.runtime.probeExecutionRecovery(h.session.id, input.runId, owner)).rejects.toMatchObject({ code: 'RECOVERY_EXECUTION_ACTIVE' });
    release(); await pending;
    expect(h.prompts).toEqual(['original']);
    // Reopening replaces the failing fake provider; the retirement proof remains authoritative.
    await h.reopen(); const decision = await h.decision(); await h.runtime.confirmExecutionRecovery(h.session.id, decision, owner);
    await vi.waitFor(() => expect(h.prompts).toEqual(['original', 'queued', 'concurrent queued']));
    await h.runtime.confirmExecutionRecovery(h.session.id, decision, owner);
    expect(h.prompts).toEqual(['original', 'queued', 'concurrent queued']);
  });
});
