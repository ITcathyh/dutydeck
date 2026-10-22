import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedSessionUuid, type CliAdapter } from '@dutydeck/cli-adapters';
import { isTmuxAvailable, TmuxBackend } from '@dutydeck/session-backends';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, DriverFactory } from '@dutydeck/shared';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { buildSessionMarker } from '../../pty-driver/src/session-id/index.js';
import { DutydeckRuntime } from './index.js';

const tmuxDescribe = await isTmuxAvailable() ? describe : describe.skip;
tmuxDescribe('restart with a live fixture CLI in isolated tmux', () => {
  const originalTmuxDirectory = process.env.TMUX_TMPDIR;
  let tmuxDirectory: string;
  const cleanup: Array<() => void | Promise<void>> = [];
  beforeAll(() => { tmuxDirectory = mkdtempSync(join(tmpdir(), 'dd-restart-tmux-')); process.env.TMUX_TMPDIR = tmuxDirectory; });
  afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });
  afterAll(() => {
    if (originalTmuxDirectory === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = originalTmuxDirectory;
    rmSync(tmuxDirectory, { recursive: true, force: true });
  });

  async function fixture(permissionMode: 'full-trust' | 'ask' = 'full-trust', submissionGate?: Promise<void>) {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-restart-cli-'));
    cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
    const database = join(cwd, 'dutydeck.db'), pidPath = join(cwd, 'pid'), finishPath = join(cwd, 'finish');
    const prompts: string[] = [], drivers: PtyCliDriver[] = [];
    let transcript = '', name = '';
    const factory: DriverFactory = (agent, _protocol, onEvent, onExit, sessionId) => {
      const project = join(cwd, 'projects', realpathSync(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
      mkdirSync(project, { recursive: true });
      transcript = join(project, `${pinnedSessionUuid(sessionId)}.jsonl`);
      if (!existsSync(transcript)) writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: pinnedSessionUuid(sessionId), message: { role: 'user', content: buildSessionMarker(sessionId) } }) + '\n');
      name = `dd-restart-${sessionId}`;
      const adapter: CliAdapter = {
        id: 'claude-code', capabilities: {}, buildArgs: () => [], buildResumeCommand: () => [], injectSessionContext: () => '',
        async writeInput(backend, prompt) {
          prompts.push(prompt);
          backend.write(`echo $$ > '${pidPath}'; while [ ! -f '${finishPath}-${prompts.length}' ]; do sleep 0.1; done; echo FIXTURE-DONE; touch '${finishPath}-${prompts.length}-completed'\n`);
          await submissionGate;
        },
        completionPattern: /FIXTURE-DONE/,
      };
      const driver = new PtyCliDriver({ agent, adapter, backend: new TmuxBackend(name, { ownerId: `dutydeck:${sessionId}` }), onEvent, onExit, sessionId });
      drivers.push(driver); return driver;
    };
    const agent: AgentConfig = { id: 'claude-code', name: 'Fixture', command: '/bin/sh', args: ['-c', 'exec /bin/sh'], protocol: 'pty-cli', cwd,
      env: { CLAUDE_CONFIG_DIR: cwd }, permissionMode, timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
    async function open() {
      const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
      const runtime = new DutydeckRuntime(repos, { driverFactory: factory, probe: () => ({ available: true, protocol: 'pty-cli', pause: false, resume: true }) });
      let closed = false;
      const close = async () => { if (closed) return; closed = true; await runtime.shutdown(); repos.close(); };
      cleanup.push(close);
      await runtime.initialize([agent]);
      return { runtime, repos, close };
    }
    cleanup.push(() => { if (name) { try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* gone */ } } });
    const first = await open();
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'long original input');
    await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
    return { ...first, open, session, task, prompts, drivers, pid: () => Number(readFileSync(pidPath, 'utf8').trim()),
      transcript: () => transcript,
      backend: () => new TmuxBackend(name, { ownerId: `dutydeck:${session.id}` }),
      completed: (turn = 1) => existsSync(`${finishPath}-${turn}-completed`),
      complete: (turn = 1) => {
        writeFileSync(`${finishPath}-${turn}`, 'done');
        appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture result' }], stop_reason: 'end_turn' } }) + '\n');
      } };
  }

  it('preserves the same live process and original attempt, never resubmits, and settles once', async () => {
    const h = await fixture(), pid = h.pid();
    const attempt = h.repos.execution.getTaskExecution(h.task.id)!.currentAttempt!;
    expect(attempt.submission?.recovery?.transcript.path).toBeTruthy();
    expect(await h.runtime.getRestartActivity()).toEqual({ runningTasks: 1, restartBlockers: 1, recoverableTasks: 0 });
    h.runtime.setQueueHeld(true);
    await vi.waitFor(async () => expect(await h.runtime.getRestartActivity()).toEqual({ runningTasks: 1, restartBlockers: 0, recoverableTasks: 1 }));
    expect(await h.runtime.getRestartActivity(h.session.id)).toEqual({ runningTasks: 0, restartBlockers: 0, recoverableTasks: 0 });
    await h.close();
    expect(await TmuxBackend.probeSession(h.backend().sessionName)).toBe('exists');
    expect(() => process.kill(pid, 0)).not.toThrow();
    const second = await h.open();
    expect(h.pid()).toBe(pid);
    expect(second.repos.execution.getTaskExecution(h.task.id)?.currentAttempt?.attemptId).toBe(attempt.attemptId);
    expect(h.prompts).toEqual(['long original input']);
    expect(second.runtime.getRunningTaskCount()).toBe(1);
    second.runtime.setQueueHeld(true);
    await vi.waitFor(async () => expect((await second.runtime.getRestartActivity()).recoverableTasks).toBe(1));
    h.complete();
    await vi.waitFor(async () => expect((await second.runtime.getTasks(h.session.id))[0]?.status).toBe('completed'), { timeout: 10_000 });
    expect(second.repos.execution.getTaskExecution(h.task.id)?.currentAttempt).toMatchObject({
      attemptId: attempt.attemptId, state: 'settled', outcome: 'completed', submission: { submissionId: attempt.submission!.submissionId }
    });
    expect((await second.runtime.getEvents(h.session.id)).filter(event => event.type === 'completed')).toHaveLength(1);
    expect(h.prompts).toEqual(['long original input']);
  });

  it('collects a result completed while stopped and continues queued tasks in order', async () => {
    const h = await fixture(), pid = h.pid();
    const attempt = h.repos.execution.getTaskExecution(h.task.id)!.currentAttempt!;
    h.runtime.setQueueHeld(true);
    const secondTask = await h.runtime.dispatch(h.session.id, 'queued second');
    const thirdTask = await h.runtime.dispatch(h.session.id, 'queued third');
    expect([secondTask.status, thirdTask.status]).toEqual(['queued', 'queued']);
    await vi.waitFor(async () => expect((await h.runtime.getRestartActivity()).recoverableTasks).toBe(1));
    await h.close();
    h.complete();
    await vi.waitFor(() => expect(h.completed()).toBe(true));

    const restored = await h.open();
    await vi.waitFor(() => expect(h.prompts).toEqual(['long original input', 'queued second']), { timeout: 10_000 });
    expect(h.pid()).toBe(pid);
    expect(restored.repos.execution.getTaskExecution(h.task.id)?.currentAttempt).toMatchObject({
      attemptId: attempt.attemptId, state: 'settled', outcome: 'completed', submission: { submissionId: attempt.submission!.submissionId }
    });
    expect((await restored.runtime.getTasks(h.session.id)).find(task => task.id === thirdTask.id)?.status).toBe('queued');
    expect((await restored.runtime.getEvents(h.session.id)).filter(event => event.type === 'completed')).toHaveLength(1);
    h.complete(2);
    await vi.waitFor(() => expect(h.prompts).toEqual(['long original input', 'queued second', 'queued third']), { timeout: 10_000 });
    h.complete(3);
    await vi.waitFor(async () => expect((await restored.runtime.getTasks(h.session.id)).every(task => task.status === 'completed')).toBe(true), { timeout: 10_000 });
    expect((await restored.runtime.getEvents(h.session.id)).filter(event => event.type === 'completed')).toHaveLength(3);
    expect(h.prompts).toEqual(['long original input', 'queued second', 'queued third']);
  });

  it('waits for submission completion before trusting a prepared checkpoint', async () => {
    let release!: () => void;
    const h = await fixture('full-trust', new Promise<void>(resolve => { release = resolve; }));
    h.runtime.setQueueHeld(true);
    expect(await h.runtime.getRestartActivity()).toEqual({ runningTasks: 1, restartBlockers: 1, recoverableTasks: 0 });
    release();
    await vi.waitFor(async () => expect((await h.runtime.getRestartActivity()).recoverableTasks).toBe(1));
    h.complete();
  });

  it('rejects a proof when the driver stops during its metadata probe', async () => {
    const h = await fixture();
    h.runtime.setQueueHeld(true);
    await vi.waitFor(async () => expect((await h.runtime.getRestartActivity()).recoverableTasks).toBe(1));
    const recovery = h.repos.execution.getTaskExecution(h.task.id)!.currentAttempt!.submission!.recovery!;
    const original = TmuxBackend.prototype.getDutydeckMetadata;
    let entered!: () => void, release!: () => void;
    const probing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const metadata = vi.spyOn(TmuxBackend.prototype, 'getDutydeckMetadata').mockImplementation(async function (key) {
      if (key === 'turn_id') { entered(); await gate; }
      return original.call(this, key);
    });
    try {
      const proof = h.drivers[0]!.canRecoverTurn(recovery);
      await probing;
      h.drivers[0]!.prepareForDaemonShutdown(true);
      await h.drivers[0]!.stop();
      release();
      expect(await proof).toBe(false);
    } finally { release(); metadata.mockRestore(); }
  });

  it.each(['ask', 'missing-stamp', 'foreign-owner', 'missing-cursor', 'missing-transcript', 'truncated-transcript', 'approval', 'risk'])('waits when recovery or permission proof is unsafe (%s)', async reason => {
    const h = await fixture(reason === 'ask' ? 'ask' : 'full-trust');
    h.runtime.setQueueHeld(true);
    if (reason !== 'ask') await vi.waitFor(async () => expect((await h.runtime.getRestartActivity()).recoverableTasks).toBe(1));
    if (reason === 'missing-stamp') await h.backend().setDutydeckMetadata('turn_id', 'unconfirmed');
    if (reason === 'foreign-owner') execFileSync('tmux', ['set-option', '-t', h.backend().sessionName, '@dutydeck_owner_id', 'foreign']);
    if (reason === 'missing-cursor') {
      const state = h.repos.execution.getTaskExecution(h.task.id)!.currentAttempt!.submission!.recovery!;
      expect(await h.drivers[0]!.canRecoverTurn({ ...state, transcript: { offset: 0 } })).toBe(false);
      h.complete(); return;
    }
    if (reason === 'missing-transcript') rmSync(h.transcript());
    if (reason === 'truncated-transcript') writeFileSync(h.transcript(), '');
    if (reason === 'approval') h.drivers[0]!.requestPermission({ title: 'Pending fixture permission' });
    if (reason === 'risk') {
      // The live policy provider may enable a gate after the task was admitted.
      (h.runtime as unknown as { options: { resolveRiskPolicy: () => Promise<unknown> } }).options.resolveRiskPolicy = async () => ({ enabled: true, authorized: false, pattern: '.*' });
    }
    expect(await h.runtime.getRestartActivity()).toEqual({ runningTasks: 1, restartBlockers: 1, recoverableTasks: 0 });
    h.complete();
  });
});
