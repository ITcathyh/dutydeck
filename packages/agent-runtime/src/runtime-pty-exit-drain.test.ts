import { defaultDriverProviders } from '../../../apps/server/src/driver-providers.js';
import { runtimeComponents } from '../test-support/components.js';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { PtyBackend } from '@dutydeck/session-backends';
import { PtyCliDriver } from '../../pty-driver/src/driver.js';
import { DutydeckRuntime } from './index.js';

const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean | Promise<boolean>, message: string) {
  await vi.waitFor(async () => expect(await predicate(), message).toBe(true), { timeout: 12_000 });
}

async function runCase(mode: 'natural' | 'stop_during_drain' | 'hold_attempt_control') {
  const cwd = mkdtempSync(join(tmpdir(), 'runtime-exit-drain-'));
  const fixture = join(cwd, 'immediate-exit.mjs');
  const tail = `FINAL-OUTPUT-${mode}`;
  writeFileSync(fixture, `process.stdout.write('READY\\r\\n'); process.stdin.once('data', () => { process.stdout.write(${JSON.stringify(tail + '\r\n')}); process.exitCode = 0; process.stdin.destroy(); });\n`);
  const gate = deferred(), entered = deferred(), observeEndGate = deferred(), observerEntered = deferred(), sendRejected = deferred();
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let driver!: PtyCliDriver;
  let sessionId = '';
  let exitWork: Promise<void> | undefined;
  let stream: ReturnType<PtyCliDriver['createTerminalStream']> | undefined;
  let terminal = '', killCalls = 0, disposeCalls = 0;
  const runtimeExits: Array<number | null> = [];
  const runtime = new DutydeckRuntime(repos, {
    providers: defaultDriverProviders(),
    cleanupIntervalMs: 0, driverIdleTimeoutMs: 0,
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    observeTurn: async (_session, _taskId, phase) => {
      if (phase === 'end') { observerEntered.resolve(); if (mode === 'hold_attempt_control') await observeEndGate.promise; }
    },
    ptyDriverFactory: (agent, _protocol, onEvent, onExit, id) => {
      const backend = new PtyBackend();
      const kill = backend.kill.bind(backend);
      backend.kill = () => { killCalls++; kill(); };
      driver = new PtyCliDriver({ agent, backend, sessionId: id,
        adapter: { id: 'exit-drain-fixture', capabilities: {}, buildArgs: () => [fixture],
          injectSessionContext: () => '', completionPattern: /THIS_FIXTURE_NEVER_COMPLETES/,
          writeInput: target => { target.write('go\r'); } },
        onEvent, onExit: code => { onExit(code); },
      });
      const send = driver.send.bind(driver);
      driver.send = prompt => { const work = send(prompt); void work.catch(() => { sendRejected.resolve(); }); return work; };
      const handleExit = (driver as any).handleExit.bind(driver);
      (driver as any).handleExit = (...args: unknown[]) => {
        exitWork = handleExit(...args);
        return exitWork;
      };
      return driver;
    },
  });
  let stopping: Promise<void> | undefined;
  try {
    const agent = { id: 'exit-drain-fixture', name: 'Exit drain fixture', command: process.execPath, args: [], cwd,
      env: { HOME: cwd, XDG_RUNTIME_DIR: cwd }, protocol: 'pty-cli' as const,
      permissionMode: 'full-trust' as const, timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id, cwd }); sessionId = session.id;
    runtime.onDriverExit(session.id, code => runtimeExits.push(code));
    stream = driver.createTerminalStream();
    stream.onData(data => { terminal += data; });
    await until(async () => (await runtime.getEvents(session.id)).some(event => event.type === 'raw_terminal' && String((event.data as any).text).includes('READY')), 'initial READY persisted');
    const renderer = (driver as any).snapshot;
    const writeAndFlush = renderer.writeAndFlush.bind(renderer);
    const dispose = renderer.dispose.bind(renderer);
    renderer.dispose = () => { disposeCalls++; dispose(); };
    let tailObserved = false;
    renderer.writeAndFlush = async (data: string, onParsed?: () => void) => {
      if (data.includes(tail)) { tailObserved = true; entered.resolve(); }
      if (tailObserved && (data.includes(tail) || data === '')) await gate.promise;
      return writeAndFlush(data, onParsed);
    };
    const task = await runtime.dispatch(session.id, 'write a final line and exit');
    await until(() => tailObserved && !!exitWork, 'tail and real PTY exit observed');
    await entered.promise;
    if (mode === 'hold_attempt_control') await observerEntered.promise;
    else await sendRejected.promise;
    const projection = repos.execution.getTaskExecution(task.id)!;
    const attemptId = projection.attempts[0]!.attemptId;
    const generationBefore = (runtime as any).sessionGenerations.get(session.id);
    expect(terminal).toContain(tail);
    expect(runtimeExits).toEqual([]);
    expect((await runtime.getEvents(session.id)).some(event => event.type === 'raw_terminal' && String((event.data as any).text).includes(tail))).toBe(false);

    let stopSettled = false;
    if (mode === 'stop_during_drain') {
      stopping = runtime.stop(session.id, owner);
      void stopping.then(() => { stopSettled = true; }, () => { stopSettled = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(stopSettled).toBe(false);
    }
    gate.resolve();
    await exitWork;
    if (stopping) await stopping;
    while (runtimeComponents(runtime).events.driverEventChains.size) await Promise.all([...runtimeComponents(runtime).events.driverEventChains.values()]);

    const persisted = await runtime.getEvents(session.id);
    const persistedTail = persisted.filter(event => event.type === 'raw_terminal' && String((event.data as any).text).includes(tail));
    const attemptTail = repos.execution.getAttemptEvents(attemptId, { limit: 500 }).filter(event => event.type === 'raw_terminal' && String((event.data as any).text).includes(tail));
    expect(persistedTail).toHaveLength(1);
    expect(persistedTail[0]).toMatchObject({ taskId: task.id, attemptId });
    expect(attemptTail).toHaveLength(1);
    expect(attemptTail[0]).toMatchObject({ taskId: task.id, attemptId });
    expect(runtimeExits).toEqual([0]);
    expect(disposeCalls).toBe(0);
    if (mode === 'stop_during_drain') {
      expect((runtime as any).sessionGenerations.get(session.id)).toBeGreaterThan(generationBefore);
      expect(killCalls).toBe(1);
    }

    observeEndGate.resolve();
    await until(() => runtime.getActiveTaskContext(session.id) === undefined, 'Runtime error cleanup complete');
    expect(repos.execution.getTaskExecution(task.id)?.task.status).toBe('reconcile_required');
    return { task, attemptId, persistedTail, attemptTail };
  } finally {
    gate.resolve(); observeEndGate.resolve();
    if (exitWork) await exitWork.catch(() => {});
    if (stopping) await stopping.catch(() => {});
    stream?.dispose();
    await runtime.shutdown().catch(() => {});
    repos.close(); rmSync(cwd, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'linux')('Runtime terminal exit drain attribution', () => {
  it('persists a natural exit tail into the original task and attempt after send rejects', async () => {
    await runCase('natural');
  }, 20_000);

  it('coordinates public stop with the exit drain without losing or reassigning the tail', async () => {
    await runCase('stop_during_drain');
  }, 20_000);

  it('keeps the observeTurn end-hold control on the same original attempt', async () => {
    await runCase('hold_attempt_control');
  }, 20_000);
});
