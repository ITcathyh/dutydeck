import { runtimeComponents } from '../test-support/components.js';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { PtyBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { PluginHookBus } from '../../../apps/server/src/plugins/hooks.js';
import { PluginRuntimeHooks } from '../../../apps/server/src/plugins/integration.js';
import { DutydeckRuntime } from './index.js';

const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  await vi.waitFor(async () => expect(await predicate(), message).toBe(true), { timeout: 12_000 });
}

type Mode = 'restarted_stop' | 'shutdown' | 'review_stop' | 'review_natural';
async function runCase(mode: Mode) {
  const reviewing = mode === 'review_stop' || mode === 'review_natural';
  const cwd = mkdtempSync(join(tmpdir(), 'runtime-exit-boundary-'));
  const fixture = join(cwd, 'immediate-exit.mjs');
  const tail = `FINAL-OUTPUT-${mode}`;
  writeFileSync(fixture, `process.stdout.write('READY\\r\\n'); const finish = () => { process.stdout.write(${JSON.stringify(tail + '\r\n')}); process.exitCode = 0; process.stdin.destroy(); }; process.stdin.once('data', () => { ${reviewing ? "process.stdout.write('WAITING_PERMISSION\\r\\n'); process.stdin.once('data', finish);" : 'finish();'} });\n`);
  const gate = deferred(), sendRejected = deferred(), reviewGate = deferred(), reviewEntered = deferred();
  const hooks = reviewing ? new PluginRuntimeHooks(new PluginHookBus([{ kind: 'handler', plugin: 'review-fixture', scope: 'global', event: 'permission.request', timeout: 60_000,
    handler: async () => { reviewEntered.resolve(); await reviewGate.promise; return { decision: 'allow' }; } }])) : undefined;
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let driver!: PtyCliDriver, backend!: PtyBackend, sessionId = '';
  let exitWork: Promise<void> | undefined;
  let stream: ReturnType<PtyCliDriver['createTerminalStream']> | undefined;
  let terminal = '', killCalls = 0;
  const emittedTail: string[] = [];
  const runtimeExits: Array<number | null> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0, driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    ...(hooks ? { reviewPermission: (session, request) => hooks.reviewPermission(session, request) } : {}),
    log: { warn: (data: any, message: string) => warnings.push({ message, code: data?.code }) } as any,
    ptyDriverFactory: (agent, _protocol, onEvent, onExit, id) => {
      backend = new PtyBackend();
      const kill = backend.kill.bind(backend);
      backend.kill = () => { killCalls++; return kill(); };
      driver = new PtyCliDriver({ agent, backend, sessionId: id,
        adapter: { id: reviewing ? 'claude-code' : 'exit-drain-fixture', capabilities: {}, buildArgs: () => [fixture],
          injectSessionContext: () => '', completionPattern: /THIS_FIXTURE_NEVER_COMPLETES/,
          writeInput: target => { target.write('go\r'); } },
        onEvent: event => {
          if (event.type === 'raw_terminal' && String(event.data.text).includes(tail)) emittedTail.push(String(event.data.text));
          onEvent(event);
        },
        onExit,
      });
      const send = driver.send.bind(driver);
      driver.send = prompt => { const work = send(prompt); void work.catch(() => { sendRejected.resolve(); }); return work; };
      const handleExit = (driver as any).handleExit.bind(driver);
      (driver as any).handleExit = (...args: unknown[]) => { exitWork = handleExit(...args); return exitWork; };
      return driver;
    },
  });
  let control: Promise<void> | undefined;
  let pendingDecision: Promise<unknown> | undefined;
  try {
    const agent = { id: 'exit-drain-fixture', name: 'Exit drain fixture', command: process.execPath, args: [], cwd,
      env: { HOME: cwd, XDG_RUNTIME_DIR: cwd }, protocol: 'pty-cli' as const,
      permissionMode: 'full-trust' as const, timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id, cwd }); sessionId = session.id;
    if (mode === 'restarted_stop') {
      await until(() => String((driver as any).snapshot?.text()).includes('READY'), 'first idle driver READY');
      backend.write('go\r');
      await until(() => !!exitWork, 'first idle driver native exit');
      await exitWork;
      await runtime.restart(session.id, owner);
      exitWork = undefined; killCalls = 0; emittedTail.length = 0;
    }
    runtime.onDriverExit(session.id, code => runtimeExits.push(code));
    stream = driver.createTerminalStream(); stream.onData(data => { terminal += data; });
    await until(async () => (await runtime.getEvents(session.id)).some(event => event.type === 'raw_terminal' && String((event.data as any).text).includes('READY')), 'initial READY persisted');
    const renderer = (driver as any).snapshot, writeAndFlush = renderer.writeAndFlush.bind(renderer);
    let tailObserved = false;
    renderer.writeAndFlush = async (data: string, onParsed?: () => void) => {
      if (data.includes(tail)) tailObserved = true;
      if (tailObserved && (data.includes(tail) || data === '')) await gate.promise;
      return writeAndFlush(data, onParsed);
    };
    const beforeTaskSequence = (await runtime.getEvents(session.id)).at(-1)?.sequence ?? 0;
    const task = await runtime.dispatch(session.id, 'write a final line and exit');
    if (reviewing) {
      await until(() => terminal.includes('WAITING_PERMISSION') && (driver as any).turnActive, 'active turn awaiting permission');
      const pending = driver.requestPermission?.({ title: 'Pending fixture permission' });
      expect(pending).toBeDefined();
      pendingDecision = pending!.decision;
      void pendingDecision.catch(() => {});
      await reviewEntered.promise;
      backend.write('exit\r');
    }
    await until(() => tailObserved && !!exitWork, 'tail and real PTY exit observed');
    await sendRejected.promise;
    const attemptId = repos.execution.getTaskExecution(task.id)!.attempts[0]!.attemptId;
    expect(terminal).toContain(tail);
    expect(runtimeExits).toEqual([]);
    if (reviewing) { gate.resolve(); await exitWork; }

    if (mode === 'review_natural') {
      const startedAt = Date.now();
      await until(() => runtime.getActiveTaskContext(session.id) === undefined
        && repos.execution.getTaskExecution(task.id)?.task.status === 'reconcile_required'
        && warnings.some(warning => warning.code === 'DRIVER_EXIT_DRAIN_TIMEOUT'), 'bounded natural exit cleanup');
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(repos.execution.getTaskExecution(task.id)?.attempts[0]).toMatchObject({ attemptId, state: 'reconcile_required' });
      const exitedDriver = driver, generationBefore = (runtime as any).sessionGenerations.get(session.id);
      expect(runtimeComponents(runtime).events.hasExitedDrain(exitedDriver)).toBe(true);
      expect(emittedTail).toHaveLength(1);

      reviewGate.resolve();
      await runtimeComponents(runtime).events.drainAll();
      expect(runtime.getPendingPermissions(session.id)).toEqual([]);

      // The natural cleanup above needs no control call. Retire the exited resource
      // afterwards so an explicitly recovered replacement attempt can check late-event isolation.
      await expect(runtime.stop(session.id, owner)).rejects.toMatchObject({ code: 'DRIVER_EXIT_DRAIN_TIMEOUT' });
      if (pendingDecision) expect(await pendingDecision).toMatchObject({ approved: false });
      const recovery = await runtime.inspectExecutionRecovery(session.id, owner);
      const unknown = recovery.tasks.find(item => item.taskId === task.id)!.attempt!;
      await runtime.confirmExecutionRecovery(session.id, { runId: recovery.runId, taskId: task.id, attemptId,
        expectedRevision: unknown.revision, decisionId: 'natural-exit-unknown', action: 'confirm_result', outcome: 'unknown',
        evidenceRefs: ['test:natural-exit-unknown'], resourceChecks: recovery.resourceChecks }, owner);
      const nextTask = await runtime.dispatch(session.id, 'new work must not inherit the exited turn');
      let nextAttemptId = '';
      await until(() => {
        const nextAttempt = repos.execution.getTaskExecution(nextTask.id)?.attempts[0];
        if (!nextAttempt) return false;
        nextAttemptId = nextAttempt.attemptId;
        return runtime.getActiveTaskContext(session.id)?.attemptId === nextAttemptId && driver !== exitedDriver;
      }, 'replacement attempt after the late approval');
      expect((runtime as any).sessionGenerations.get(session.id)).toBeGreaterThan(generationBefore);

      const sessionEvents = await runtime.getEvents(session.id);
      const persistedTail = sessionEvents.filter(event => event.sequence > beforeTaskSequence && event.type === 'raw_terminal' && String((event.data as any).text).includes(tail));
      const attemptTail = repos.execution.getAttemptEvents(attemptId, { limit: 500 }).filter(event => event.type === 'raw_terminal' && String((event.data as any).text).includes(tail));
      const nextAttemptEvents = repos.execution.getAttemptEvents(nextAttemptId, { limit: 500 });
      const nextAttemptTail = nextAttemptEvents.filter(event => event.type === 'raw_terminal' && String((event.data as any).text).includes(tail));
      expect(persistedTail).toEqual([]);
      expect(attemptTail).toEqual([]);
      expect(nextAttemptTail).toEqual([]);
      expect(nextAttemptEvents.filter(event => event.type === 'permission_request')).toEqual([]);
      expect(sessionEvents.filter(event => event.type === 'permission_request' && event.data?.status === 'approved')).toEqual([]);
      expect(runtime.getPendingPermissions(session.id)).toEqual([]);
      expect(runtimeComponents(runtime).events.hasExitAdmission(session.id)).toBe(false);
      return { persistedTail, attemptTail };
    }

    const startedAt = Date.now();
    control = mode === 'shutdown' ? runtime.shutdown() : runtime.stop(session.id, owner);
    void control.catch(() => {});
    if (reviewing) {
      await expect(control).rejects.toMatchObject({ code: 'DRIVER_EXIT_DRAIN_TIMEOUT' });
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(killCalls).toBe(1);
      reviewGate.resolve();
      if (pendingDecision) expect(await pendingDecision).toMatchObject({ approved: false });
      await runtimeComponents(runtime).events.drainAll();
      expect(runtime.getPendingPermissions(session.id)).toEqual([]);
    } else {
      let settled = false; void control.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      if (mode === 'shutdown') await expect(runtime.dispatch(session.id, 'new work must stay closed')).rejects.toMatchObject({ code: 'RUNTIME_SHUTTING_DOWN' });
      gate.resolve(); await exitWork; await control;
    }
    await until(() => runtime.getActiveTaskContext(session.id) === undefined, 'Runtime attempt cleanup');
    await runtimeComponents(runtime).events.drainAll();
    const sessionEvents = await runtime.getEvents(session.id);
    const persistedTail = sessionEvents.filter(event => event.sequence > beforeTaskSequence && event.type === 'raw_terminal' && String((event.data as any).text).includes(tail));
    const attemptTail = repos.execution.getAttemptEvents(attemptId, { limit: 500 }).filter(event => event.type === 'raw_terminal' && String((event.data as any).text).includes(tail));
    expect(emittedTail).toHaveLength(1);
    if (reviewing) {
      expect(persistedTail).toHaveLength(0);
      expect(attemptTail).toHaveLength(0);
      expect(warnings).toContainEqual(expect.objectContaining({ code: 'DRIVER_EXIT_DRAIN_TIMEOUT' }));
      expect(sessionEvents.filter(event => event.type === 'permission_request' && event.data?.status === 'approved')).toEqual([]);
    } else {
      expect(persistedTail).toHaveLength(1);
      expect(persistedTail[0]).toMatchObject({ taskId: task.id, attemptId });
      expect(attemptTail).toHaveLength(1);
      expect(attemptTail[0]).toMatchObject({ taskId: task.id, attemptId });
      expect(runtimeExits).toEqual([0]);
    }
    return { persistedTail, attemptTail };
  } finally {
    gate.resolve(); reviewGate.resolve();
    if (exitWork) await exitWork.catch(() => {});
    if (control) await control.catch(() => {});
    stream?.dispose(); await runtime.shutdown().catch(() => {});
    repos.close(); rmSync(cwd, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'linux')('Runtime exit drain lifecycle boundaries', () => {
  it('keeps restart parent ownership until the second run tail is durable', async () => {
    await runCase('restarted_stop');
  }, 20_000);

  it('persists an accepted exit tail during shutdown while rejecting new work', async () => {
    await runCase('shutdown');
  }, 20_000);

  it('bounds source plus plugin-review persistence and fences the late approval', async () => {
    await runCase('review_stop');
  }, 20_000);

  it('bounds natural error cleanup and fences late events from the replacement attempt', async () => {
    await runCase('review_natural');
  }, 20_000);
});
