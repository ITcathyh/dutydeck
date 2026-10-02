import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { PersistentEventPublisher } from './persistent-event-publisher.js';
import { JsonlTailer } from '../../pty-driver/src/transcript/tail.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver, BoundExecutionRepository, NormalizedDriverEvent, Session, TaskRequestV1 } from '@dutydeck/shared';
import { DriverRecoveryError } from '@dutydeck/shared';
import { DutydeckRuntime, type RuntimeOptions } from './index.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const agent: AgentConfig = { id: 'fixture', name: 'Fixture', command: process.execPath, args: [], protocol: 'jsonl', env: {}, permissionMode: 'ask', model: 'default-model', timeout: 10, builtin: false, capabilities: { pause: false, resume: true } };
function request(sessionId: string, key: string, options: TaskRequestV1['options'] = {}): TaskRequestV1 {
  return { version: 1, namespace: 'runtime', sessionId, key, prompt: key, mode: 'queue', actor: { kind: 'unspecified' }, options, skills: [], sources: [], sourcePayload: {} };
}
async function fixture(options: RuntimeOptions = {}, onSend?: (emit: (event: NormalizedDriverEvent) => void, prompt: string) => Promise<void>, observeBound?: (bound: BoundExecutionRepository) => void, afterSpawn?: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-ledger-'));
  const path = join(directory, 'state.sqlite');
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  if (observeBound) { const bind = repos.execution.bind.bind(repos.execution); vi.spyOn(repos.execution, 'bind').mockImplementation(claim => { const bound = bind(claim); observeBound(bound); return bound; }); }
  const children: Array<{ child: ChildProcess; exited: Promise<unknown> }> = [];
  const sent: string[] = [], models: string[] = [];
  const stopGate = deferred();
  let emit!: (event: NormalizedDriverEvent) => void;
  let driver!: AgentDriver;
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, ...options,
    probe: () => ({ protocol: 'jsonl', available: true, pause: false, resume: true }),
    driverFactory: (_config, _protocol, onEvent) => {
      emit = onEvent;
      let processEntry: { child: ChildProcess; exited: Promise<unknown> } | undefined;
      driver = {
        start: async () => {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          processEntry = { child, exited: once(child, 'exit') }; children.push(processEntry);
          await once(child, 'spawn');
          await afterSpawn?.();
        },
        send: async prompt => {
          sent.push(prompt);
          if (onSend) await Promise.race([onSend(onEvent, prompt), stopGate.promise.then(() => { throw new Error('original process stopped'); })]);
          else { onEvent({ type: 'text', sourceId: 'provider-text', data: { text: prompt } }); onEvent({ type: 'completed', data: { stopReason: 'end_turn' } }); }
        },
        stop: async () => { stopGate.resolve(); if (processEntry && processEntry.child.exitCode === null && processEntry.child.signalCode === null) processEntry.child.kill('SIGTERM'); await processEntry?.exited; },
        isStopped: async () => Boolean(processEntry && (processEntry.child.exitCode !== null || processEntry.child.signalCode !== null)),
        interrupt: async () => {}, resume: async () => {}, setModel: async model => { models.push(model); }, resolvePermission: async () => true
      };
      return driver;
    }
  });
  cleanup.push(async () => {
    stopGate.resolve();
    for (const entry of children) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
    await Promise.allSettled(children.map(entry => entry.exited));
    await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true });
  });
  await runtime.initialize([{ ...agent, cwd: directory }]);
  const session = await runtime.start({ agentId: agent.id, cwd: directory });
  return { repos, runtime, session, path, directory, sent, models, children, emit: (event: NormalizedDriverEvent) => emit(event), driver: () => driver };
}

describe('Runtime uses the execution ledger', () => {
  it.each([false, true])('finishes an already completed send without replaying history (sync subscribe callback: %s)', async synchronous => {
    const h = await fixture();
    const envelope = request(h.session.id, 'already-completed');
    const first = await h.runtime.send(h.session.id, envelope.prompt, envelope.prompt, undefined, undefined, [], envelope);
    const highWaterMark = h.repos.events.highWaterMark(h.session.id);
    const pages = vi.spyOn(h.repos.events, 'listWindow');
    const watermark = vi.spyOn(h.repos.events, 'highWaterMark');
    let removed = false;
    const subscribe = PersistentEventPublisher.prototype.subscribe;
    vi.spyOn(PersistentEventPublisher.prototype, 'subscribe').mockImplementation(function (id, listener, options) {
      const unsubscribe = subscribe.call(this, id, listener, options);
      if (synchronous) void listener({} as never);
      return () => { removed = true; unsubscribe(); };
    });
    const replay = await h.runtime.send(h.session.id, envelope.prompt, envelope.prompt, undefined, undefined, [], envelope);
    expect(replay.currentAttemptId).toBe(first.currentAttemptId);
    expect(replay.status).toBe('completed');
    expect(watermark).toHaveBeenCalledWith(h.session.id);
    expect(pages.mock.calls.every(([, options]) => (options?.afterSequence ?? 0) >= highWaterMark)).toBe(true);
    expect(removed).toBe(true);
  });

  it('resolves a queued send cancelled before its first Attempt', async () => {
    const gate = deferred();
    const h = await fixture({}, async () => { await gate.promise; });
    cleanup.push(async () => { gate.resolve(); });
    await h.runtime.dispatch(h.session.id, 'blocking');
    await vi.waitFor(() => expect(h.sent).toEqual(['blocking']));
    const waiting = h.runtime.send(h.session.id, 'cancel-me');
    let taskId = '';
    await vi.waitFor(async () => { taskId = (await h.runtime.getTasks(h.session.id)).find(task => task.prompt === 'cancel-me')!.id; });
    await h.runtime.cancelQueued(h.session.id, taskId, 'installation_owner');
    expect(await waiting).toMatchObject({ id: taskId, status: 'cancelled' });
    expect(h.repos.execution.getTaskExecution(taskId)?.attempts).toEqual([]);
  });

  it('attributes a final multi-chunk transcript record to the original Attempt before completion', async () => {
    const text = 'sanitized answer'.repeat(100_000);
    let h: Awaited<ReturnType<typeof fixture>>;
    h = await fixture({}, async (emit, prompt) => {
      const path = join(h.directory, 'transcript.jsonl');
      writeFileSync(path, '');
      const tailer = new JsonlTailer({ resolvePath: () => path, mapEntry: entry => [{ type: 'text', data: { text: entry.text } }] });
      tailer.onEvent(emit); tailer.start();
      try {
        await tailer.flush();
        appendFileSync(path, JSON.stringify({ text: prompt === 'first' ? text : 'next' }) + '\n');
        await tailer.flush();
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      } finally { tailer.stop(); }
    });
    const first = await h.runtime.send(h.session.id, 'first');
    const second = await h.runtime.send(h.session.id, 'second');
    const events = await h.runtime.getEvents(h.session.id);
    const result = events.find(event => event.type === 'text' && event.data.text === text)!;
    const completed = events.find(event => event.type === 'completed' && event.attemptId === first.currentAttemptId)!;
    expect(result.attemptId).toBe(first.currentAttemptId);
    expect(result.sequence).toBeLessThan(completed.sequence);
    expect(second.currentAttemptId).not.toBe(result.attemptId);
  });

  it('rejects legacy before saving Agent config or obtaining a Runtime claim', async () => {
    const repos = createRepositories(':memory:'); const save = vi.spyOn(repos.agents, 'save'), attach = vi.spyOn(repos.control, 'attachRuntime');
    const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0 });
    await expect(runtime.initialize([agent])).rejects.toMatchObject({ code: 'EXECUTION_UPGRADE_REQUIRED' });
    expect(save).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled(); await runtime.shutdown();
  });
  it('settles distinct Attempts when the provider repeats its event sourceId', async () => {
    const h = await fixture();
    const first = await h.runtime.send(h.session.id, 'one', 'one', undefined, undefined, [], request(h.session.id, 'one'));
    const second = await h.runtime.send(h.session.id, 'two', 'two', undefined, undefined, [], request(h.session.id, 'two'));
    expect(first.status).toBe('completed'); expect(second.status).toBe('completed');
    const events = await h.runtime.getEvents(h.session.id);
    const text = events.filter(event => event.type === 'text' && (event.data as { role?: string }).role !== 'user');
    expect(text).toHaveLength(2); expect(new Set(text.map(event => event.id)).size).toBe(2); expect(new Set(text.map(event => event.attemptId)).size).toBe(2);
    expect(h.sent).toEqual(['one', 'two']);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(2);
    expect(events.map(event => event.sequence)).toEqual(Array.from({ length: events.length }, (_, index) => index + 1));
  });
  it('returns an accepted replay before rereading mutable prompt material', async () => {
    const prepare = vi.fn(async (_session: Session, prompt: string) => ({ agentPrompt: 'frozen:' + prompt }));
    const h = await fixture({ prepareTaskPrompt: prepare }); const envelope = request(h.session.id, 'input');
    const first = await h.runtime.send(h.session.id, 'input', 'input', undefined, undefined, [], envelope);
    const second = await h.runtime.dispatch(h.session.id, 'input', 'queue', 'different downloaded bytes', undefined, undefined, envelope.key, [], envelope);
    expect(second.id).toBe(first.id); expect(second.replayed).toBe(true); expect(prepare).toHaveBeenCalledTimes(1); expect(h.sent).toEqual(['frozen:input']);
    expect(h.runtime.lookupAcceptedTask(envelope)?.input?.executionContext.agentPrompt).toBe('frozen:input');
  });
  it('rejects a mismatched explicit envelope before acceptance', async () => {
    const h = await fixture();
    await expect(h.runtime.dispatch(h.session.id, 'different', 'queue', 'different', undefined, undefined, 'original', [], request(h.session.id, 'original'))).rejects.toMatchObject({ code: 'TASK_REQUEST_MISMATCH' });
    expect(await h.runtime.getTasks(h.session.id)).toEqual([]); expect(h.sent).toEqual([]);
  });
  it('does not turn a rejected submitted send into failed or advance the queue', async () => {
    const h = await fixture({}, async () => { throw new Error('response lost after submission'); });
    const result = await h.runtime.send(h.session.id, 'one');
    expect(result.status).toBe('reconcile_required');
    const stored = h.repos.execution.getTaskExecution(result.id)!;
    expect(stored.currentAttempt).toMatchObject({ state: 'reconcile_required', submissionState: 'intent_recorded' });
    expect(stored.currentAttempt?.settlementId).toBeUndefined();
    await h.runtime.dispatch(h.session.id, 'two');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.sent).toEqual(['one']);
    expect((await h.runtime.getTasks(h.session.id)).find(task => task.prompt === 'two')?.status).toBe('queued');
  });
  it('suspends preparation on shutdown and never sends from a late authorization continuation', async () => {
    const gate = deferred(), entered = deferred();
    const h = await fixture({ authorizeTask: async (_s, _t, phase) => { if (phase === 'prepare') { entered.resolve(); await gate.promise; } } });
    const task = await h.runtime.dispatch(h.session.id, 'pending'); await entered.promise;
    await h.runtime.shutdown(); gate.resolve();
    const value = h.repos.execution.getTaskExecution(task.id)!;
    expect(value.currentAttempt).toMatchObject({ state: 'suspended', submissionState: 'not_submitted', number: 1 });
    expect(value.task.status).toBe('queued'); expect(h.sent).toEqual([]);
    expect(h.repos.execution.getResources(h.session.id).filter(row => row.kind === 'local_only').every(row => row.observations.at(-1)?.state === 'gone')).toBe(true);
  });
  it.each(['prepare', 'submit'] as const)('cancels a fixed preparing Attempt interrupted during %s authorization, with zero sends', async blockedPhase => {
    const gate = deferred(), entered = deferred();
    const h = await fixture({ authorizeTask: async (_s, _t, phase) => { if (phase === blockedPhase) { entered.resolve(); await gate.promise; } } });
    const task = await h.runtime.dispatch(h.session.id, 'pending'); await entered.promise;
    await h.runtime.interrupt(h.session.id, task.id, 'installation_owner', 'prepare-interrupt'); gate.resolve();
    const value = h.repos.execution.getTaskExecution(task.id)!;
    expect(value.currentAttempt).toMatchObject({ state: 'settled', submissionState: 'not_submitted', outcome: 'cancelled' });
    expect(h.sent).toEqual([]);
    expect(value.task.interruptedByActor).toBe('installation_owner');
  });
  it('applies the next Task default after a per-Task model without changing Session defaults', async () => {
    const h = await fixture();
    await h.runtime.send(h.session.id, 'one', 'one', undefined, undefined, [], request(h.session.id, 'one', { model: 'special-model' }));
    await h.runtime.send(h.session.id, 'two', 'two', undefined, undefined, [], request(h.session.id, 'two'));
    expect(h.models).toEqual(['special-model', 'default-model']);
    expect((await h.runtime.getSession(h.session.id))?.model).toBe('default-model');
  });
  it('fails unsupported Task configuration before submission and keeps the original driver and defaults', async () => {
    const h = await fixture(); const original = h.driver(); delete original.setModel;
    const result = await h.runtime.send(h.session.id, 'special', 'special', undefined, undefined, [], request(h.session.id, 'special', { model: 'unrestorable-model' }));
    const attempt = h.repos.execution.getTaskExecution(result.id)!.currentAttempt!;
    expect(result.status).toBe('failed');
    expect(attempt.submissionState).toBe('not_submitted');
    expect(attempt.settlement).toMatchObject({ kind: 'not_submitted', reason: 'This driver cannot prove a context-preserving configuration reset before submission' });
    expect(h.runtime.getDriver(h.session.id)).toBe(original); expect(h.children).toHaveLength(1); expect(h.sent).toEqual([]);
    expect((await h.runtime.getSession(h.session.id))?.model).toBe('default-model');
    expect((await h.runtime.send(h.session.id, 'default')).status).toBe('completed');
    expect(h.sent).toEqual(['default']);
  });
  it('keeps configuration unknown when a successful native setter cannot persist Session defaults', async () => {
    const h = await fixture();
    vi.spyOn(h.repos.sessions, 'save').mockRejectedValueOnce(new Error('defaults write failed'));
    await expect(h.runtime.setModel(h.session.id, 'B')).rejects.toMatchObject({ code: 'MODEL_SWITCH_FAILED' });
    expect(h.models).toEqual(['B']); expect((await h.runtime.getSession(h.session.id))?.model).toBe('default-model');
    expect(JSON.parse((await h.repos.config.get('runtime_driver_configuration:' + h.session.id))!).state).toBe('unknown');
    expect((await h.runtime.send(h.session.id, 'default')).status).toBe('failed'); expect(h.sent).toEqual([]);
    await h.runtime.stop(h.session.id);
    await expect(h.runtime.resume(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
  });
  it('allows only the original configuration RPC to finish and records defaults before clearing its gate', async () => {
    const h = await fixture(); const entered = deferred(), release = deferred();
    cleanup.push(async () => { release.resolve(); });
    const original = vi.fn(async () => { entered.resolve(); await release.promise; }); h.driver().setModel = original;
    const effort = vi.fn(async () => {}); h.driver().setReasoningEffort = effort;
    const changing = h.runtime.setModel(h.session.id, 'B'); await entered.promise;
    await expect(h.runtime.setReasoningEffort(h.session.id, 'high')).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_BUSY' });
    expect(effort).not.toHaveBeenCalled(); expect(original).toHaveBeenCalledTimes(1);
    const blocked = await h.runtime.send(h.session.id, 'before ACK');
    expect(blocked.status).toBe('failed'); expect(h.sent).toEqual([]);
    release.resolve(); await changing;
    expect((await h.runtime.getSession(h.session.id))?.model).toBe('B');
    expect(await h.repos.config.get('runtime_driver_configuration:' + h.session.id)).toBe('');
    expect((await h.runtime.send(h.session.id, 'after ACK')).status).toBe('completed'); expect(h.sent).toEqual(['after ACK']);
    expect(original).toHaveBeenCalledTimes(1);
  });
  it('drains a revoked configuration ACK before releasing the claim and never clears it as known', async () => {
    const h = await fixture(); const entered = deferred(), release = deferred();
    cleanup.push(async () => { release.resolve(); });
    h.driver().setModel = async () => { entered.resolve(); await release.promise; };
    const changing = h.runtime.setModel(h.session.id, 'B').catch(error => error); await entered.promise;
    let finished = false; const shutdown = h.runtime.shutdown().then(() => { finished = true; });
    await h.children[0]!.exited;
    expect(finished).toBe(false); expect(() => h.repos.control.attachRuntime('too-early-configuration')).toThrow();
    expect(JSON.parse((await h.repos.config.get('runtime_driver_configuration:' + h.session.id))!).state).toBe('pending');
    release.resolve(); await changing; await shutdown;
    expect(JSON.parse((await h.repos.config.get('runtime_driver_configuration:' + h.session.id))!).state).toBe('unknown');
    expect((await h.repos.sessions.get(h.session.id))?.model).toBe('default-model');
    h.repos.control.attachRuntime('after-configuration-tail').release();
  });
  it('keeps the old local_only blocker when stop resolves but physical exit is unverified', async () => {
    const h = await fixture();
    vi.spyOn(h.driver(), 'stop').mockResolvedValueOnce();
    h.driver().isStopped = vi.fn(h.driver().isStopped!.bind(h.driver())).mockResolvedValueOnce(false);
    await expect(h.runtime.stop(h.session.id)).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED' });
    expect(h.repos.execution.getSessionResourceBlockers(h.session.id).map(block => block.code)).toContain('DRIVER_RESOURCE_UNSAFE');
    expect(h.children[0]?.child.exitCode).toBe(null);
    await expect(h.runtime.restart(h.session.id)).resolves.toBeDefined();
  });
  it('hashes all assistant text past one event page, excluding user and thinking text', async () => {
    const output = '字'.repeat(205);
    const h = await fixture({}, async emit => {
      for (let index = 0; index < 205; index++) emit({ type: 'text', data: { text: '字' } });
      emit({ type: 'status', data: { usage: 205 } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    const task = await h.runtime.send(h.session.id, 'user content');
    const attempt = h.repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    expect(attempt.settlement).toMatchObject({ kind: 'driver_result', outputDigest: createHash('sha256').update(output, 'utf8').digest('hex') });
    const events = await h.runtime.getEvents(h.session.id);
    const settled = events.filter(event => event.attemptId === attempt.attemptId && event.settlementId === attempt.settlementId);
    expect(settled.at(-1)).toMatchObject({ type: 'completed', settlementId: attempt.settlementId });
  });
  it('does not let an old permission card resolve the next Attempt with the same native ID', async () => {
    const gates = [deferred(), deferred()]; let turn = 0;
    const h = await fixture({}, async emit => {
      const gate = gates[turn++]!;
      emit({ type: 'permission_request', data: { id: 'same-native', title: 'write', status: 'pending' } });
      await gate.promise;
      emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    cleanup.push(async () => { for (const gate of gates) gate.resolve(); });
    const first = h.runtime.send(h.session.id, 'one');
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(h.session.id)).toHaveLength(1));
    const old = h.runtime.getPendingPermissions(h.session.id)[0]!.id;
    await h.runtime.resolvePermission(h.session.id, old, true); gates[0]!.resolve(); await first;
    const second = h.runtime.send(h.session.id, 'two');
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(h.session.id)).toHaveLength(1));
    const current = h.runtime.getPendingPermissions(h.session.id)[0]!.id;
    expect(current).not.toBe(old);
    const resolve = vi.spyOn(h.driver(), 'resolvePermission');
    await expect(h.runtime.resolvePermission(h.session.id, old, true)).rejects.toMatchObject({ code: 'PERMISSION_NOT_FOUND' });
    expect(resolve).not.toHaveBeenCalled();
    await h.runtime.resolvePermission(h.session.id, current, true); expect(resolve).toHaveBeenCalledWith('same-native', true);
    gates[1]!.resolve(); await second;
  });

  it('preserves queued work without inventing a stopping actor and prevents archive/run changes', async () => {
    const entered = deferred(), pending = deferred();
    const h = await fixture({}, async () => { entered.resolve(); await pending.promise; });
    cleanup.push(async () => { pending.resolve(); });
    const active = await h.runtime.dispatch(h.session.id, 'active'); await entered.promise;
    const queued = await h.runtime.dispatch(h.session.id, 'queued');
    await expect(h.runtime.stop(h.session.id)).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
    expect(h.repos.execution.getTaskExecution(active.id)?.currentAttempt?.state).toBe('active');
    expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('queued');
    expect(await h.driver().isStopped()).toBe(false);
    expect(h.runtime.getDriver(h.session.id)).toBeDefined();
    expect(h.sent).toEqual(['active']);
    await expect(h.runtime.archive(h.session.id)).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
    await expect(h.runtime.restart(h.session.id)).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
    expect((await h.runtime.getSession(h.session.id))?.runId).toBe(h.session.runId);
    expect((await h.runtime.getSession(h.session.id))?.archivedAt).toBeFalsy();
    await h.runtime.stop(h.session.id, { kind: 'installation_owner', id: 'installation_owner' });
    expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('cancelled');
  });
  it('keeps the full platform actor when stopping a WorkItem and accepts persistent gone proof', async () => {
    const pending = deferred(), entered = deferred(); let bound!: BoundExecutionRepository;
    const h = await fixture({}, async () => { entered.resolve(); await pending.promise; }, value => { bound = value; });
    cleanup.push(async () => { pending.resolve(); });
    const child = await h.runtime.startWorkItemSession({ agentId: agent.id, cwd: h.directory, source: 'work_item', sourceId: 'work-attempt', workspaceMode: 'shared' }, 'ses_work_' + createHash('sha256').update('work-attempt').digest('hex'), async () => {});
    const actor = { kind: 'channel' as const, id: 'user', appId: 'original-app' };
    const first = { ...request(child.id, 'active'), namespace: 'work_item' as const, actor };
    const second = { ...request(child.id, 'queued'), namespace: 'work_item' as const, actor };
    await h.runtime.dispatch(child.id, first.prompt, 'queue', first.prompt, undefined, actor.id, first.key, [], first); await entered.promise;
    const queued = await h.runtime.dispatch(child.id, second.prompt, 'queue', second.prompt, undefined, actor.id, second.key, [], second);
    const cancel = vi.spyOn(bound, 'cancelQueued');
    await expect(h.runtime.stopWorkItemSession(child.id, actor)).resolves.toBe(true);
    expect(cancel.mock.calls.some(call => call[1] === queued.id && JSON.stringify(call[3].actor) === JSON.stringify(actor))).toBe(true);
    expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('cancelled');
    expect(h.runtime.getDriver(child.id)).toBeUndefined();
    await expect(h.runtime.stopWorkItemSession(child.id, actor)).resolves.toBe(true);
  });
  it('rejects missing and unspecified WorkItem stopping actors even when JavaScript bypasses the required parameter', async () => {
    const h = await fixture();
    const child = await h.runtime.startWorkItemSession({ agentId: agent.id, cwd: h.directory, source: 'work_item', sourceId: 'required-actor', workspaceMode: 'shared' }, 'ses_work_' + createHash('sha256').update('required-actor').digest('hex'), async () => {});
    await expect(Reflect.apply(h.runtime.stopWorkItemSession, h.runtime, [child.id])).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
    expect(h.runtime.getDriver(child.id)).toBeUndefined(); expect(h.repos.execution.getSessionResourceBlockers(child.id)).toEqual([]);
    await expect(h.runtime.stopWorkItemSession(child.id, { kind: 'unspecified' })).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
  });
  it('reopening a submitted unknown Attempt preserves its failure evidence without adopting or resending', async () => {
    const h = await fixture({}, async () => { throw new Error('lost result'); });
    const task = await h.runtime.send(h.session.id, 'one');
    const original = h.repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    await h.runtime.shutdown(); h.repos.close();
    const repos = createRepositories(h.path, { newDatabaseAuthority: 'ledger_v1' });
    const create = vi.fn((): AgentDriver => { throw new Error('must not recreate unknown turn'); });
    const runtime = new DutydeckRuntime(repos, { driverFactory: create, cleanupIntervalMs: 0 });
    cleanup.push(async () => { await runtime.shutdown(); repos.close(); });
    await runtime.initialize([{ ...agent, cwd: h.directory }]);
    const restored = repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    expect(restored.attemptId).toBe(original.attemptId); expect(restored.controller).toEqual(original.controller);
    expect(restored.submission).toEqual(original.submission); expect(restored.recoveryControllers).toEqual([]);
    expect(restored.state).toBe('reconcile_required'); expect(restored.reconcileReason).toEqual(original.reconcileReason);
    expect(restored.reconcileReason?.code).toBe('DRIVER_RESULT_UNKNOWN');
    expect(create).not.toHaveBeenCalled(); expect(h.sent).toEqual(['one']);
  });
  it('replays a queue promotion against its original target while the promoted task is now active', async () => {
    const entered = deferred(), firstGate = deferred(), secondGate = deferred();
    const h = await fixture({}, async (emit, prompt) => {
      if (prompt === 'first') { entered.resolve(); await firstGate.promise; }
      if (prompt === 'second') await secondGate.promise;
      emit({ type: 'text', data: { text: prompt } }); emit({ type: 'completed', data: { stopReason: prompt === 'first' ? 'cancelled' : 'end_turn' } });
    });
    cleanup.push(async () => { firstGate.resolve(); secondGate.resolve(); });
    const first = await h.runtime.dispatch(h.session.id, 'first'); await entered.promise;
    await h.runtime.dispatch(h.session.id, 'third'); const second = await h.runtime.dispatch(h.session.id, 'second');
    const interrupt = vi.spyOn(h.driver(), 'interrupt').mockImplementation(async () => { firstGate.resolve(); });
    await h.runtime.steerQueued(h.session.id, second.id, 'installation_owner', undefined, 'fixed-promotion');
    await vi.waitFor(() => expect(h.sent).toEqual(['first', 'second']));
    await h.runtime.steerQueued(h.session.id, second.id, 'installation_owner', undefined, 'fixed-promotion');
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(h.repos.execution.getTaskExecution(first.id)?.currentAttempt?.outcome).toBe('interrupted');
    expect(h.repos.execution.getTaskExecution(second.id)?.currentAttempt?.state).toBe('active');
    secondGate.resolve(); await vi.waitFor(() => expect(h.sent).toEqual(['first', 'second', 'third']));
  });

  it('repairs a committed acceptance in this process when the immediate queue projection fails', async () => {
    const h = await fixture(); const envelope = request(h.session.id, 'durable');
    h.repos.tasks.listQueued = vi.fn(h.repos.tasks.listQueued!.bind(h.repos.tasks)).mockRejectedValueOnce(new Error('transient projection read failure'));
    await expect(h.runtime.dispatch(h.session.id, envelope.prompt, 'queue', envelope.prompt, undefined, undefined, envelope.key, [], envelope)).rejects.toThrow('transient projection read failure');
    const accepted = h.runtime.lookupAcceptedTask(envelope)!;
    expect(accepted.task.id).toBeDefined();
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(accepted.task.id)?.task.status).toBe('completed'));
    expect(h.sent).toEqual(['durable']);
  });
  it('does not claim the next Task while the captured event and artifact tail is still running', async () => {
    const entered = deferred(), gate = deferred();
    const h = await fixture({}, async (emit, prompt) => {
      emit({ type: 'tool_call', data: { id: 'same-tool', name: 'read', status: 'running' } });
      emit({ type: 'text', sourceId: 'same-text', data: { text: prompt } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    cleanup.push(async () => { gate.resolve(); });
    const save = h.repos.artifacts.saveToolCall.bind(h.repos.artifacts);
    vi.spyOn(h.repos.artifacts, 'saveToolCall').mockImplementationOnce(async (...args) => { entered.resolve(); await gate.promise; return save(...args); });
    const first = await h.runtime.dispatch(h.session.id, 'first'); await entered.promise;
    const secondDispatch = h.runtime.dispatch(h.session.id, 'second');
    expect(h.sent).toEqual(['first']);
    expect(h.repos.execution.getTaskExecution(first.id)?.currentAttempt?.state).toBe('active');
    gate.resolve(); const second = await secondDispatch;
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(second.id)?.task.status).toBe('completed'));
    for (const task of [first, second]) {
      const value = h.repos.execution.getTaskExecution(task.id)!;
      const events = h.repos.execution.getAttemptEvents(value.currentAttempt!.attemptId);
      expect(events.filter(event => event.type === 'text' && (event.data as { role?: string }).role !== 'user').map(event => (event.data as { text: string }).text)).toEqual([task.prompt]);
    }
    expect(h.sent).toEqual(['first', 'second']);
  });
  it('keeps pending startup resources and the claim until the real creation tail ends', async () => {
    const entered = deferred(), gate = deferred(); let starts = 0;
    const h = await fixture({}, undefined, undefined, async () => { if (++starts === 2) { entered.resolve(); await gate.promise; } });
    cleanup.push(async () => { gate.resolve(); });
    const starting = h.runtime.start({ agentId: agent.id, cwd: h.directory });
    const rejected = expect(starting).rejects.toThrow();
    await entered.promise;
    const second = (await h.repos.sessions.list()).find(session => session.id !== h.session.id)!;
    expect(h.repos.execution.getResources(second.id).every(resource => resource.stage === 'pending')).toBe(true);
    let finished = false; const shutdown = h.runtime.shutdown().then(() => { finished = true; });
    await h.children[1]!.exited;
    expect(finished).toBe(false);
    expect(() => h.repos.control.attachRuntime('too-early')).toThrow();
    expect(h.repos.execution.getSessionResourceBlockers(second.id).length).toBeGreaterThan(0);
    gate.resolve(); await rejected; await shutdown;
    expect(h.repos.execution.getSessionResourceBlockers(second.id)).toEqual([]);
    expect(h.repos.execution.getResources(second.id).filter(resource => resource.kind === 'local_only').every(resource => resource.observations.at(-1)?.state === 'gone')).toBe(true);
    h.repos.control.attachRuntime('after-drain').release();
  });
  it('holds the claim through an already running publisher callback during shutdown', async () => {
    const h = await fixture(); const entered = deferred(), gate = deferred();
    cleanup.push(async () => { gate.resolve(); });
    h.runtime.subscribe(h.session.id, async () => { entered.resolve(); await gate.promise; });
    await h.runtime.publishSessionEvent(h.session.id, 'text', { text: 'notification' }); await entered.promise;
    let finished = false; const shutdown = h.runtime.shutdown().then(() => { finished = true; });
    await h.children[0]!.exited;
    expect(finished).toBe(false);
    expect(() => h.repos.control.attachRuntime('before-publisher-close')).toThrow();
    gate.resolve(); await shutdown;
    h.repos.control.attachRuntime('after-publisher-close').release();
  });
  it('keeps a successful settlement when one subscriber fails and replays that subscriber later', async () => {
    const h = await fixture(); const received: number[] = []; let fail = true;
    const unsubscribe = h.runtime.subscribe(h.session.id, event => { if (fail) { fail = false; throw new Error('consumer unavailable'); } received.push(event.sequence); });
    const task = await h.runtime.send(h.session.id, 'one');
    expect(task.status).toBe('completed');
    const expected = (await h.runtime.getEvents(h.session.id)).filter(event => event.taskId === task.id).map(event => event.sequence);
    await vi.waitFor(() => expect(received.filter(sequence => expected.includes(sequence))).toEqual(expected), { timeout: 2500 });
    expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt?.outcome).toBe('completed'); unsubscribe();
  });
  it.each(['injected','startedNewTurn'] as const)('records %s delivery into the running Attempt and takes it off the queue', async outcome => {
    const entered = deferred(), gate = deferred();
    const h = await fixture({}, async (emit, prompt) => {
      if (prompt === 'first') { entered.resolve(); await gate.promise; }
      emit({ type: 'text', data: { text: prompt } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    cleanup.push(async () => { gate.resolve(); });
    const first = await h.runtime.dispatch(h.session.id, 'first'); await entered.promise;
    const second = await h.runtime.dispatch(h.session.id, 'second');
    const steer = vi.fn(async (_prompt: string) => outcome); h.driver().steer = steer;
    const result = await h.runtime.injectQueued(h.session.id, second.id, 'installation_owner', 'fixed-steering');
    expect(result).toMatchObject({ outcome, task: { id: second.id, status: 'completed' } });
    expect(steer).toHaveBeenCalledWith('second');
    expect(h.repos.execution.getTaskExecution(second.id)?.attempts).toEqual([]);
    const marker = (await h.runtime.getEvents(h.session.id)).find(event => event.type === 'text' && (event.data as { steering?: unknown }).steering);
    expect(marker?.data).toMatchObject({ role: 'user', text: 'second', taskId: second.id, steering: { outcome, target: { taskId: first.id } } });
    gate.resolve(); await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(first.id)?.task.status).toBe('completed'));
    expect(h.sent).toEqual(['first']);
  });
  it.each([
    ['unsupported', undefined],
    ['promptRequired', async () => 'promptRequired' as const],
    ['unsupported', async () => 'unsupported' as const]
  ] as const)('keeps the Task queued as a normal next turn when steering is %s', async (outcome, steer) => {
    const entered = deferred(), gate = deferred();
    const h = await fixture({}, async (emit, prompt) => {
      if (prompt === 'first') { entered.resolve(); await gate.promise; }
      emit({ type: 'text', data: { text: prompt } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    cleanup.push(async () => { gate.resolve(); });
    await h.runtime.dispatch(h.session.id, 'first'); await entered.promise;
    const second = await h.runtime.dispatch(h.session.id, 'second');
    if (steer) h.driver().steer = steer;
    const result = await h.runtime.injectQueued(h.session.id, second.id, 'installation_owner');
    expect(result).toMatchObject({ outcome, task: { id: second.id, status: 'queued' } });
    expect(h.sent).toEqual(['first']);
    gate.resolve(); await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(second.id)?.task.status).toBe('completed'));
    expect(h.sent).toEqual(['first', 'second']);
  });
  it('holds an unanswered steering request after 30 seconds and converges a late acknowledgement without replay', async () => {
    const entered = deferred(), gate = deferred(), asked = deferred();
    const h = await fixture({}, async (emit, prompt) => {
      if (prompt === 'first') { entered.resolve(); await gate.promise; }
      emit({ type: 'text', data: { text: prompt } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    cleanup.push(async () => { gate.resolve(); });
    const first = await h.runtime.dispatch(h.session.id, 'first'); await entered.promise;
    const second = await h.runtime.dispatch(h.session.id, 'second');
    let answer!: (outcome: 'injected') => void;
    h.driver().steer = () => { asked.resolve(); return new Promise(done => { answer = done; }); };
    // Take over only the 30-second steering timer; the rest of the turn keeps real time.
    const realSetTimeout = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== 30_000) return realSetTimeout(handler, ms, ...args);
      expire = () => handler(...args);
      return realSetTimeout(() => {}, 60_000);
    }) as unknown as typeof setTimeout);
    const steering = h.runtime.injectQueued(h.session.id, second.id, 'installation_owner');
    await asked.promise;
    // Completion of the original target does not prove the steered input was not accepted.
    gate.resolve(); await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(first.id)?.task.status).toBe('completed'));
    expect(h.sent).toEqual(['first']);
    expire!();
    await expect(steering).resolves.toMatchObject({ outcome: 'failed', task: { status: 'reconcile_required' } });
    expect(h.repos.execution.getTaskExecution(second.id)?.steering?.state).toBe('unknown');
    expect(h.repos.execution.getUnresolvedTasks(h.session.id)).toContainEqual({id:second.id,status:'reconcile_required'});
    expect(h.sent).toEqual(['first']);
    answer('injected');
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(second.id)?.task.status).toBe('completed'));
    expect(h.sent).toEqual(['first']);
    expect(h.repos.execution.getTaskExecution(second.id)?.attempts).toHaveLength(0);
  });
  it.each(['throw','sync throw'] as const)('persists uncertain delivery on %s and never creates a second Attempt', async failure => {
    const entered=deferred(), gate=deferred(); let sideEffects=0;
    const h=await fixture({},async (emit,prompt)=>{ if(prompt==='first'){entered.resolve();await gate.promise;} emit({type:'text',data:{text:prompt}});emit({type:'completed',data:{stopReason:'end_turn'}}); });
    cleanup.push(async()=>{gate.resolve();});
    const first=await h.runtime.dispatch(h.session.id,'first'); await entered.promise;
    const second=await h.runtime.dispatch(h.session.id,'second');
    h.driver().steer=failure==='sync throw' ? ()=>{sideEffects++;throw new Error('connection lost after delivery');} : async()=>{sideEffects++;throw new Error('connection lost after delivery');};
    await expect(h.runtime.injectQueued(h.session.id,second.id,'installation_owner','once')).resolves.toMatchObject({outcome:'failed',task:{status:'reconcile_required'}});
    await expect(h.runtime.injectQueued(h.session.id,second.id,'installation_owner','once')).resolves.toMatchObject({outcome:'failed',task:{status:'reconcile_required'}});
    gate.resolve(); await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(first.id)?.task.status).toBe('completed'));
    expect(sideEffects).toBe(1); expect(h.sent).toEqual(['first']);
    expect(h.repos.execution.getTaskExecution(second.id)).toMatchObject({attempts:[],steering:{state:'unknown'}});
  });
  it('stops before the acknowledgement deadline even when the remote reply never settles',async()=>{
    const entered=deferred(),gate=deferred(),asked=deferred();
    const h=await fixture({},async(emit,prompt)=>{if(prompt==='first'){entered.resolve();await gate.promise;}emit({type:'text',data:{text:prompt}});emit({type:'completed',data:{stopReason:'end_turn'}});});
    cleanup.push(async()=>{gate.resolve();});
    const first=await h.runtime.dispatch(h.session.id,'first');await entered.promise;const second=await h.runtime.dispatch(h.session.id,'second');
    h.driver().steer=()=>{asked.resolve();return new Promise(()=>{});};
    const steering=h.runtime.injectQueued(h.session.id,second.id,'installation_owner');await asked.promise;
    gate.resolve();await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(first.id)?.task.status).toBe('completed'));
    const owner={kind:'installation_owner' as const,id:'installation_owner' as const};
    await h.runtime.stop(h.session.id,owner);
    await expect(steering).resolves.toMatchObject({outcome:'failed',task:{status:'reconcile_required'}});
    const state=await h.runtime.inspectExecutionRecovery(h.session.id,owner), operation=state.tasks.find(t=>t.taskId===second.id)!.steering!;
    await expect(h.runtime.confirmSteeringRecovery(h.session.id,{runId:state.runId,taskId:second.id,operationId:operation.operationId,expectedRevision:operation.revision,decisionId:'abandon-stopped',evidenceRefs:['operator:stopped'],resourceChecks:state.resourceChecks,action:'abandon'},owner)).resolves.toMatchObject({task:{status:'cancelled'}});
    expect(h.sent).toEqual(['first']);
  });
  it.each(['delivered','not_delivered','abandon'] as const)('requires stopped resources before manual %s and ignores a later acknowledgement', async action => {
    const entered=deferred(), gate=deferred(), asked=deferred();
    const h=await fixture({},async (emit,prompt)=>{if(prompt==='first'){entered.resolve();await gate.promise;}emit({type:'text',data:{text:prompt}});emit({type:'completed',data:{stopReason:'end_turn'}});});
    cleanup.push(async()=>{gate.resolve();});
    const first=await h.runtime.dispatch(h.session.id,'first');await entered.promise;
    const second=await h.runtime.dispatch(h.session.id,'second');
    let answer!:(outcome:'injected')=>void;
    h.driver().steer=()=>{asked.resolve();return new Promise(done=>{answer=done;});};
    const realSetTimeout=globalThis.setTimeout;let expire!:()=>void;
    vi.spyOn(globalThis,'setTimeout').mockImplementation(((handler:(...args:unknown[])=>void,ms?:number,...args:unknown[])=>{if(ms!==30_000)return realSetTimeout(handler,ms,...args);expire=()=>handler(...args);return realSetTimeout(()=>{},60_000);}) as typeof setTimeout);
    const steering=h.runtime.injectQueued(h.session.id,second.id,'installation_owner','manual-operation');await asked.promise;expire();await steering;
    gate.resolve();await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(first.id)?.task.status).toBe('completed'));
    const owner={kind:'installation_owner' as const,id:'installation_owner' as const};
    const decision=async()=>{const state=await h.runtime.inspectExecutionRecovery(h.session.id,owner);const operation=state.tasks.find(t=>t.taskId===second.id)!.steering!;return{runId:state.runId,taskId:second.id,operationId:operation.operationId,expectedRevision:operation.revision,decisionId:'manual-choice',evidenceRefs:['operator:reviewed'],resourceChecks:state.resourceChecks,action,...(action==='not_delivered'?{allowDuplicateEffects:true as const}:{})};};
    await expect(h.runtime.confirmSteeringRecovery(h.session.id,await decision(),owner)).rejects.toMatchObject({code:'RECOVERY_EXECUTION_ACTIVE'});
    await expect(h.runtime.confirmSteeringRecovery(h.session.id,await decision(),{kind:'unspecified'})).rejects.toMatchObject({code:'RECOVERY_OWNER_REQUIRED'});
    if(action==='abandon'){
      const prove=h.driver().isStopped!;h.driver().isStopped=async()=>false;
      await expect(h.runtime.stop(h.session.id,owner)).rejects.toMatchObject({code:'DRIVER_STOP_UNVERIFIED'});
      await expect(h.runtime.confirmSteeringRecovery(h.session.id,await decision(),owner)).rejects.toMatchObject({code:'RECOVERY_EXECUTION_ACTIVE'});
      h.driver().isStopped=prove;
    }
    await h.runtime.stop(h.session.id,owner);
    await expect(h.runtime.restart(h.session.id,owner)).rejects.toMatchObject({code:'STEERING_DELIVERY_UNKNOWN'});
    const input=await decision();
    await expect(h.runtime.confirmSteeringRecovery(h.session.id,{...input,expectedRevision:input.expectedRevision+1},owner)).rejects.toMatchObject({code:'STEERING_REVISION_CONFLICT'});
    if(action==='not_delivered'){const {allowDuplicateEffects:_,...missing}=input;await expect(h.runtime.confirmSteeringRecovery(h.session.id,missing as never,owner)).rejects.toThrow();}
    const result=await h.runtime.confirmSteeringRecovery(h.session.id,input,owner);expect(result.replayed).toBe(false);
    await expect(h.runtime.confirmSteeringRecovery(h.session.id,input,owner)).resolves.toMatchObject({replayed:true});
    answer('injected');
    if(action==='not_delivered')await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(second.id)?.task.status).toBe('completed'));
    else await new Promise(done=>setTimeout(done,30));
    const projection=h.repos.execution.getTaskExecution(second.id)!;
    expect(projection.steering).toMatchObject({state:action==='abandon'?'abandoned':action,decisionId:'manual-choice'});
    expect(projection.attempts).toHaveLength(action==='not_delivered'?1:0);
    expect(h.sent).toEqual(action==='not_delivered'?['first','second']:['first']);
    if(action==='abandon')expect(projection.task.status).toBe('cancelled');
  });
  it.each(['pending','unknown'] as const)('retains %s steering across runtime shutdown and a new runtime without replay',async state=>{
    const entered=deferred(),gate=deferred();const h=await fixture({},async(emit,prompt)=>{if(prompt==='first'){entered.resolve();await gate.promise;}emit({type:'text',data:{text:prompt}});emit({type:'completed',data:{stopReason:'end_turn'}});});cleanup.push(async()=>{gate.resolve();});
    const first=await h.runtime.dispatch(h.session.id,'first');await entered.promise;const second=await h.runtime.dispatch(h.session.id,'second');
    if(state==='unknown'){h.driver().steer=async()=>{throw new Error('no acknowledgement');};await h.runtime.injectQueued(h.session.id,second.id,'installation_owner');}
    else {const target=h.repos.execution.getTaskExecution(first.id)!.currentAttempt!;const queued=h.repos.execution.getTaskExecution(second.id)!.task;(h.runtime as any).bound().beginQueuedSteering({sessionId:h.session.id,runId:h.session.runId},second.id,queued.revision,{operationId:'pending-before-crash',actor:{kind:'installation_owner',id:'installation_owner'},target:{taskId:first.id,attemptId:target.attemptId}});}
    gate.resolve();await vi.waitFor(()=>expect(h.repos.execution.getTaskExecution(first.id)?.task.status).toBe('completed'));await h.runtime.shutdown();
    const factory=vi.fn(()=>{throw new Error('must not create a replacement driver');});
    const next=new DutydeckRuntime(h.repos,{driverFactory:factory,driverIdleTimeoutMs:0});cleanup.push(async()=>{await next.shutdown();});await next.initialize([{...agent,cwd:h.directory}]);
    expect(factory).not.toHaveBeenCalled();expect(h.repos.execution.getTaskExecution(second.id)).toMatchObject({task:{status:'reconcile_required'},attempts:[],steering:{state:'unknown'}});
    expect(h.repos.execution.getUnresolvedTasks(h.session.id)).toContainEqual({id:second.id,status:'reconcile_required'});
  });
  it('keeps a DriverRecoveryError submitted turn unresolved instead of advancing the queue',async()=>{
    const h=await fixture({},async()=>{throw new DriverRecoveryError('turn silence deadline');});
    const first=await h.runtime.send(h.session.id,'uncertain');const second=await h.runtime.dispatch(h.session.id,'after');
    expect(first.status).toBe('reconcile_required');expect(h.repos.execution.getTaskExecution(first.id)?.currentAttempt).toMatchObject({state:'reconcile_required',submissionState:'intent_recorded'});
    await new Promise(done=>setTimeout(done,30));expect(h.sent).toEqual(['uncertain']);expect(h.repos.execution.getTaskExecution(second.id)?.task.status).toBe('queued');
  });
  it.each(['automation', 'schedule'] as const)('does not steer a %s Task whose consumer reads its own Attempt', async namespace => {
    const entered = deferred(), gate = deferred();
    const h = await fixture({}, async (emit, prompt) => {
      if (prompt === 'first') { entered.resolve(); await gate.promise; }
      emit({ type: 'text', data: { text: prompt } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    cleanup.push(async () => { gate.resolve(); });
    await h.runtime.dispatch(h.session.id, 'first'); await entered.promise;
    const envelope = { ...request(h.session.id, 'second'), namespace, actor: { kind: 'installation_owner', id: 'installation_owner' } } satisfies TaskRequestV1;
    const second = await h.runtime.dispatch(h.session.id, envelope.prompt, 'queue', envelope.prompt, undefined, 'installation_owner', envelope.key, [], envelope);
    const steer = vi.fn(async (_prompt: string) => 'injected' as const); h.driver().steer = steer;
    await expect(h.runtime.injectQueued(h.session.id, second.id, 'installation_owner')).resolves.toMatchObject({ outcome: 'unsupported', task: { status: 'queued' } });
    expect(steer).not.toHaveBeenCalled();
    gate.resolve(); await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(second.id)?.task.status).toBe('completed'));
    expect(h.repos.execution.getTaskExecution(second.id)?.attempts).toHaveLength(1);
  });
  it('does not inject a queued Task whose execution options differ from the running turn', async () => {
    const entered = deferred(), gate = deferred();
    const h = await fixture({}, async (emit, prompt) => {
      if (prompt === 'first') { entered.resolve(); await gate.promise; }
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    cleanup.push(async () => { gate.resolve(); });
    await h.runtime.dispatch(h.session.id, 'first'); await entered.promise;
    const envelope = request(h.session.id, 'second', { model: 'special-model' });
    const second = await h.runtime.dispatch(h.session.id, envelope.prompt, 'queue', envelope.prompt, undefined, undefined, envelope.key, [], envelope);
    const steer = vi.fn(async (_prompt: string) => 'injected' as const); h.driver().steer = steer;
    expect(await h.runtime.injectQueued(h.session.id, second.id, 'installation_owner')).toMatchObject({ outcome: 'incompatible', task: { status: 'queued' } });
    expect(steer).not.toHaveBeenCalled();
  });

});
