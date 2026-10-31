import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { RuntimeError, type AgentConfig, type DriverFactory } from '@dutydeck/shared';
import { DutydeckRuntime, type PtyRetirementControl, type RuntimeOptions } from './index.js';

const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const HOUR = 60 * 60_000;

async function fixture(options: RuntimeOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-stuck-'));
  execFileSync('git', ['-C', cwd, 'init', '-q']);
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const sent: string[] = [], failures = new Map<string, Error>(), gates = new Map<string, ReturnType<typeof deferred>>();
  const factory: DriverFactory = (_agent, _protocol, emit) => {
    let busy = false;
    return { start: async () => {}, stop: async () => {}, isStopped: async () => false, interrupt: async () => {}, resume: async () => {},
      isIdle: () => !busy, hasBackgroundWork: () => false,
      send: async input => {
        const prompt = typeof input === 'string' ? input : input.prompt; sent.push(prompt); busy = true;
        try {
          await gates.get(prompt)?.promise;
          const failure = failures.get(prompt); if (failure) throw failure;
          emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
        } finally { busy = false; }
      } };
  };
  const agent: AgentConfig = { id: 'fixture', name: 'Fixture', command: 'fake', args: [], cwd, env: {}, protocol: 'pty-cli', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const warn = vi.fn(), notices = vi.fn();
  const open = (extra: RuntimeOptions = {}) => new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0,
    probe: () => ({ available: true, protocol: 'pty-cli', pause: false, resume: true }), log: { warn, info: () => {} }, onSessionNotice: notices, ...options, ...extra });
  let runtime = open();
  cleanups.push(async () => { for (const gate of gates.values()) gate.resolve(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  await runtime.initialize([agent]);
  return { repos, cwd, sent, failures, gates, warn, notices, get runtime() { return runtime; },
    reopen: async (extra: RuntimeOptions = {}) => { await runtime.shutdown(); runtime = open(extra); await runtime.initialize([agent]); } };
}
const blockedLogs = (warn: ReturnType<typeof vi.fn>) => warn.mock.calls.filter(([, message]) => message === 'Queued task is blocked by another session in the same workspace');
/** 把任务的入队时间往前拨，模拟它已经排了这么久。 */
function age(h: { cwd: string }, taskId: string, by: number) {
  const Database = createRequire(new URL('../../storage/package.json', import.meta.url))('better-sqlite3');
  const db = new Database(join(h.cwd, 'state.db'));
  try { db.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(new Date(Date.now() - by).toISOString(), taskId); } finally { db.close(); }
}
const noticeEvents = async (h: Awaited<ReturnType<typeof fixture>>, sessionId: string) =>
  (await h.repos.events.list(sessionId)).filter(event => event.type === 'status' && (event.data as { state?: string }).state === 'notice');

describe('a task held back by its repository is visible', () => {
  it('logs normal contention once without a notice and starts when the running turn ends', async () => {
    const h = await fixture();
    const one = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd }), two = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd });
    const gate = deferred(); h.gates.set('long', gate);
    const first = h.runtime.send(one.id, 'long');
    await vi.waitFor(() => expect(h.sent).toEqual(['long']));
    const queued = await h.runtime.dispatch(two.id, 'waiting');
    await vi.waitFor(() => expect(blockedLogs(h.warn)).toHaveLength(1));
    expect(blockedLogs(h.warn)[0]![0]).toMatchObject({ sessionId: two.id, taskId: queued.id, code: 'WORKSPACE_RESOURCE_BLOCKED',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'WORKSPACE_EXECUTION_BUSY', sessionId: one.id })]) });
    gate.resolve(); await first;
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('completed'));
    expect(h.notices).not.toHaveBeenCalled();
    expect(await noticeEvents(h, two.id)).toEqual([]);
  });

  it('names the result-unknown task once per blocked period and resumes on its own after it is handled', async () => {
    const h = await fixture();
    const one = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd }), two = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd });
    h.failures.set('lost', new Error('connection lost after submission'));
    const unknown = await h.runtime.send(one.id, 'lost');
    expect(unknown.status).toBe('reconcile_required');
    const queued = await h.runtime.dispatch(two.id, 'blocked');
    await vi.waitFor(() => expect(h.notices).toHaveBeenCalledTimes(1));
    const [session, notice] = h.notices.mock.calls[0]!;
    expect(session.id).toBe(two.id);
    expect(notice).toMatchObject({ kind: 'workspace_blocked', taskId: queued.id, sessionIds: [one.id] });
    for (const text of [one.id, unknown.id, '结果未知', '自动继续', '标为失败']) expect(notice.message).toContain(text);
    expect(blockedLogs(h.warn)).toHaveLength(1);
    expect(blockedLogs(h.warn)[0]![0]).toMatchObject({ blockers: expect.arrayContaining([expect.objectContaining({ code: 'WORKSPACE_EXECUTION_BUSY', sessionId: one.id, taskId: unknown.id })]) });
    expect(await noticeEvents(h, two.id)).toHaveLength(1);
    // Repeated admission retries stay quiet.
    for (let retry = 0; retry < 3; retry++) { (h.runtime as any).wakeResourceQueues(); await new Promise(resolve => setTimeout(resolve, 20)); }
    expect(h.notices).toHaveBeenCalledTimes(1); expect(blockedLogs(h.warn)).toHaveLength(1);
    expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('queued');
    await h.runtime.settleIdleAttempt(one.id, { taskId: unknown.id, decisionId: 'operator-failed', outcome: 'failed', evidenceRefs: ['operator:checked'] }, owner);
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('completed'));
    // A later blocked period is reported again.
    expect((await h.runtime.send(one.id, 'lost')).status).toBe('reconcile_required');
    const later = await h.runtime.dispatch(two.id, 'blocked again');
    await vi.waitFor(() => expect(h.notices).toHaveBeenCalledTimes(2));
    expect(h.notices.mock.calls[1]![1]).toMatchObject({ kind: 'workspace_blocked', taskId: later.id });
    expect(blockedLogs(h.warn)).toHaveLength(2);
    expect(h.sent.filter(prompt => prompt === 'lost')).toHaveLength(2);
  });
});

describe('result-unknown tasks age out only with exit proof', () => {
  const absence = { absent: true, socket: 'fixture' };
  const terminalControl = (state: { terminal: 'absent' | 'present' }) => {
    const control: PtyRetirementControl = {
      capture: () => { throw new RuntimeError('PTY_RETIREMENT_IDENTITY_UNAVAILABLE', 'No original PTY identity can be captured; missing alone is not proof of exit', 409); },
      stop: async () => { throw new Error('an absence proof must never stop a terminal'); },
      verify: (_session, snapshot) => (snapshot as { absent?: boolean }).absent === true && state.terminal === 'absent',
      captureAbsence: async () => state.terminal === 'absent' ? absence : undefined,
    };
    return control;
  };
  async function unknownLeftByPreviousRuntime(state: { terminal: 'absent' | 'present' }) {
    const h = await fixture({ ptyRetirement: terminalControl(state) });
    const one = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd });
    h.failures.set('lost', new Error('connection lost after submission'));
    const unknown = await h.runtime.send(one.id, 'lost');
    expect(unknown.status).toBe('reconcile_required');
    const startedAt = Date.parse(h.repos.execution.getTaskExecution(unknown.id)!.currentAttempt!.createdAt);
    return { h, one, unknown, startedAt };
  }
  const terminal = (h: Awaited<ReturnType<typeof fixture>>, sessionId: string) => h.repos.execution.getResources(sessionId).find(resource => resource.kind === 'local_only')!;

  it('keeps the owner runtime terminal and refuses an absence proof while that runtime still owns it', async () => {
    const state = { terminal: 'absent' as 'absent' | 'present' };
    const { h, one } = await unknownLeftByPreviousRuntime(state);
    const resource = terminal(h, one.id);
    const input = { runId: one.runId, resourceId: resource.resourceId, expectedRevision: resource.revision, decisionId: 'retire', evidenceRefs: ['operator:terminal-missing'] };
    await expect(h.runtime.retirePtyExecution(one.id, input, owner)).rejects.toMatchObject({ code: 'RESOURCE_OWNER_NOT_PROVEN_EXITED' });
    expect(terminal(h, one.id).observations.at(-1)?.state).toBe('live');
    // The next runtime still sees the terminal, so nothing is retired at startup and missing capture keeps its error.
    state.terminal = 'present';
    await h.reopen();
    expect(terminal(h, one.id).observations.at(-1)?.state).toBe('live');
    const other = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd });
    const fresh = terminal(h, one.id);
    await expect(h.runtime.retirePtyExecution(one.id, { ...input, decisionId: 'retire-present', expectedRevision: fresh.revision }, owner)).rejects.toMatchObject({ code: 'PTY_RETIREMENT_IDENTITY_UNAVAILABLE' });
    // Once the terminal is gone and its owner runtime has exited, the original decision completes and is replayable.
    state.terminal = 'absent';
    const retired = await h.runtime.retirePtyExecution(one.id, input, owner);
    expect(retired.replayed).toBe(false);
    expect(terminal(h, one.id).observations.at(-1)).toMatchObject({ state: 'gone', evidenceRef: expect.stringMatching(/^pty-retirement:/) });
    expect((await h.runtime.retirePtyExecution(one.id, input, owner)).replayed).toBe(true);
    expect(other.id).not.toBe(one.id);
    expect(h.sent).toEqual(['lost']);
  });

  it('retires the vanished terminal at startup, reminds once after a day and abandons as unknown after a week', async () => {
    const state = { terminal: 'absent' as 'absent' | 'present' };
    const { h, one, unknown, startedAt } = await unknownLeftByPreviousRuntime(state);
    await h.reopen();
    expect(terminal(h, one.id).observations.at(-1)).toMatchObject({ state: 'gone', evidenceRef: expect.stringMatching(/^pty-absent:/) });
    expect((await h.runtime.inspectExecutionRecovery(one.id, owner)).stopBlock).toBeFalsy();
    await h.runtime.cleanupIdleDrivers(startedAt + 23 * HOUR);
    expect(h.notices).not.toHaveBeenCalled();
    await h.runtime.cleanupIdleDrivers(startedAt + 25 * HOUR);
    await h.runtime.cleanupIdleDrivers(startedAt + 26 * HOUR);
    expect(h.notices).toHaveBeenCalledTimes(1);
    expect(h.notices.mock.calls[0]![1]).toMatchObject({ kind: 'unknown_task_overdue', taskId: unknown.id, sessionIds: [one.id] });
    expect(h.repos.execution.getTaskExecution(unknown.id)?.currentAttempt?.state).toBe('reconcile_required');
    await h.runtime.cleanupIdleDrivers(startedAt + 8 * 24 * HOUR);
    const attempt = h.repos.execution.getTaskExecution(unknown.id)!.currentAttempt!;
    expect(attempt).toMatchObject({ state: 'settled', outcome: 'unknown', settlement: { kind: 'manual', decision: { action: 'confirm_result', actor: owner,
      evidenceRefs: expect.arrayContaining(['unknown_task_unattended:7d']) } } });
    expect((await h.runtime.getTaskRecovery(one.id, unknown.id)).resolvedUnknown).toBe(true);
    expect(h.notices).toHaveBeenCalledTimes(2);
    expect(h.notices.mock.calls[1]![1]).toMatchObject({ kind: 'unknown_task_abandoned', taskId: unknown.id });
    expect(await noticeEvents(h, one.id)).toHaveLength(2);
    // Nothing is replayed, and the repository is free for other sessions again.
    const two = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd });
    expect((await h.runtime.send(two.id, 'after cleanup')).status).toBe('completed');
    expect(h.sent).toEqual(['lost', 'after cleanup']);
  });

  it('only reminds while the terminal may still be running or messages are queued behind it', async () => {
    const state = { terminal: 'present' as 'absent' | 'present' };
    const { h, one, unknown, startedAt } = await unknownLeftByPreviousRuntime(state);
    await h.reopen();
    await h.runtime.cleanupIdleDrivers(startedAt + 8 * 24 * HOUR);
    expect(h.repos.execution.getTaskExecution(unknown.id)?.currentAttempt?.state).toBe('reconcile_required');
    expect(h.notices.mock.calls.map(([, notice]) => notice.kind)).toEqual(['unknown_task_overdue']);
    // The terminal disappears, but a message is now queued behind the unknown turn: a person decides.
    state.terminal = 'absent';
    const queued = await h.runtime.dispatch(one.id, 'queued behind');
    await h.runtime.cleanupIdleDrivers(startedAt + 9 * 24 * HOUR + 2 * HOUR);
    expect(h.repos.execution.getTaskExecution(unknown.id)?.currentAttempt?.state).toBe('reconcile_required');
    expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('queued');
    expect(h.sent).toEqual(['lost']);
  });

  it('cancels a message queued for over a day instead of running it once startup frees the repository', async () => {
    const state = { terminal: 'present' as 'absent' | 'present' };
    const { h, one, unknown } = await unknownLeftByPreviousRuntime(state);
    const target = h.repos.execution.getTaskExecution(unknown.id)!.currentAttempt!.attemptId;
    await h.runtime.resolveUnknownTask(one.id, { taskId: unknown.id, target, decisionId: 'operator-failed', action: 'failed', evidenceRefs: ['operator:checked'] }, owner);
    // The next runtime inherits a terminal it cannot prove has exited, and it holds the repository.
    await h.reopen();
    expect(terminal(h, one.id).observations.at(-1)?.state).toBe('live');
    const two = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd });
    const old = await h.runtime.dispatch(two.id, 'old message');
    await vi.waitFor(() => expect(blockedLogs(h.warn).at(-1)?.[0]).toMatchObject({ sessionId: two.id, taskId: old.id }));
    expect(h.repos.execution.getTaskExecution(old.id)?.task.status).toBe('queued');
    age(h, old.id, 25 * HOUR);
    state.terminal = 'absent';
    await h.reopen();
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(old.id)?.task.status).toBe('cancelled'));
    expect(terminal(h, one.id).observations.at(-1)?.state).toBe('gone');
    expect(h.sent).toEqual(['lost']);
    expect(h.notices).toHaveBeenCalledWith(expect.objectContaining({ id: two.id }), expect.objectContaining({ kind: 'queue_expired', taskId: old.id, message: '排队超过 24 小时仍未开始，已取消、不会执行；需要的话请重发。' }));
    // A new message in the same session runs normally.
    expect((await h.runtime.send(two.id, 'fresh')).status).toBe('completed');
    expect(h.sent).toEqual(['lost', 'fresh']);
  });
});

describe('messages queued for over a day', () => {
  it('does not expire a memory job queued for over a day when its turn comes', async () => {
    const h = await fixture();
    h.runtime.setQueueHeld(true);
    const memory = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd, source: 'lark-memory', sourceId: 'app:groups:memory' });
    const queued = await h.runtime.dispatch(memory.id, 'old memory job');
    age(h, queued.id, 25 * HOUR);
    h.runtime.setQueueHeld(false);
    await vi.waitFor(() => expect(['completed', 'cancelled']).toContain(h.repos.execution.getTaskExecution(queued.id)?.task.status));
    expect(h.repos.execution.getTaskExecution(queued.id)?.task.status).toBe('completed');
    expect(h.sent).toEqual(['old memory job']);
    expect(h.notices.mock.calls.some(([, notice]) => notice.kind === 'queue_expired')).toBe(false);
  });

  it('still runs a day-old message whose turn comes right after a long task in the same session', async () => {
    const h = await fixture();
    const one = await h.runtime.start({ agentId: 'fixture', cwd: h.cwd });
    const gate = deferred(); h.gates.set('long', gate);
    const first = h.runtime.send(one.id, 'long');
    await vi.waitFor(() => expect(h.sent).toEqual(['long']));
    const next = await h.runtime.dispatch(one.id, 'next');
    // Both were sent a day ago; the long task has been running ever since.
    const long = (await h.repos.tasks.listBySession(one.id)).find(task => task.prompt === 'long')!;
    age(h, long.id, 25 * HOUR); age(h, next.id, 25 * HOUR);
    gate.resolve(); await first;
    await vi.waitFor(() => expect(h.repos.execution.getTaskExecution(next.id)?.task.status).toBe('completed'));
    expect(h.sent).toEqual(['long', 'next']);
    expect(h.notices).not.toHaveBeenCalled();
  });
});
