import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapter } from '@dutydeck/cli-adapters';
import { createPtyCliDriver } from '@dutydeck/pty-driver';
import { PtyBackend } from '@dutydeck/session-backends';
import { agentConfigSchema, type AgentDriver } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); vi.restoreAllMocks(); });

async function fixture(options: { authorizeTask?: NonNullable<ConstructorParameters<typeof DutydeckRuntime>[1]>['authorizeTask'] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-runtime-driver-exit-'));
  releases.push(async () => rmSync(cwd, { recursive: true, force: true }));
  const cli = join(cwd, 'cli.mjs');
  writeFileSync(cli, `
process.stdin.setRawMode(true);
process.stdout.write('READY\\n');
process.stdin.on('data', data => {
  const input = data.toString();
  const exit = /^EXIT:(\\d+)/.exec(input);
  if (exit) process.exit(Number(exit[1]));
  if (!input.includes('\\x1b[200~')) return;
  process.stdout.write('Working...\\n');
  setTimeout(() => process.stdout.write('\\x1bcanswer\\n'), 30);
});
`);
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const adapter = createCliAdapter('pi');
  const writeInput = vi.spyOn(adapter, 'writeInput');
  const drivers: AgentDriver[] = [];
  const exits: Array<(code: number | null) => void> = [];
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0,
    authorizeTask: options.authorizeTask,
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    ptyDriverFactory(agent, _protocol, onEvent, onExit, sessionId) {
      const backend = new PtyBackend();
      const driver = createPtyCliDriver({ agent, adapter, backend, onEvent, onExit, sessionId });
      drivers.push(driver); exits.push(onExit);
      return driver;
    },
  });
  releases.push(async () => { await runtime.shutdown(); repos.close(); });
  const agent = agentConfigSchema.parse({ id: 'pi', name: 'fixture', command: process.execPath, args: [cli], protocol: 'pty-cli', cwd,
    env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true } });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  const exit = async (code: number) => {
    let observed = false;
    const unsubscribe = runtime.onDriverExit(session.id, () => { observed = true; });
    const stream = drivers.at(-1)!.createTerminalStream!();
    await stream.write(`EXIT:${code}\n`);
    await vi.waitFor(() => expect(observed).toBe(true));
    unsubscribe(); stream.dispose();
  };
  return { runtime, repos, session, drivers, exits, writeInput, exit };
}

it.each([0, 17])('rebuilds an idle PTY exited with code %s before submitting concurrent new inputs', async code => {
  const h = await fixture();
  const original = h.drivers[0]!;
  await h.exit(code);
  const pending = h.runtime.send(h.session.id, 'new input');
  const queued = h.runtime.send(h.session.id, 'another input');
  const tasks = await Promise.all([pending, queued]);
  // This minimal CLI emits only raw terminal output, so Runtime settles its
  // turns as failed (no assistant text), but neither submission is uncertain.
  expect(tasks.map(task => task.status)).toEqual(['failed', 'failed']);
  expect(h.drivers).toHaveLength(2);
  expect(h.runtime.getDriver(h.session.id)).not.toBe(original);
  expect(h.writeInput).toHaveBeenCalledTimes(2);
  for (const task of tasks) expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt).toMatchObject({ state: 'settled', outcome: 'failed' });
  expect(h.repos.execution.getResources(h.session.id).filter(resource => resource.kind === 'local_only').map(resource => resource.observations.at(-1)?.state)).toEqual(['gone', 'live']);

  // A delayed exit from the retired generation cannot retire its successor.
  h.exits[0]!(17);
  const third = await h.runtime.send(h.session.id, 'third input');
  expect(third.status).toBe('failed');
  expect(h.drivers).toHaveLength(2);
  expect(h.writeInput).toHaveBeenCalledTimes(3);
});

it('fails without a submission intent when the exited driver cannot prove physical exit', async () => {
  const h = await fixture();
  await h.exit(0);
  const stopped = vi.spyOn(h.drivers[0]!, 'isStopped').mockResolvedValue(false);
  const task = await h.runtime.send(h.session.id, 'must not submit');
  expect(task.status).toBe('failed');
  expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt).toMatchObject({ state: 'settled', submissionState: 'not_submitted', outcome: 'failed' });
  expect(h.writeInput).not.toHaveBeenCalled();
  expect(h.drivers).toHaveLength(1);
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeDefined();
  stopped.mockRestore();
});

it('retains the exit when explicit resume is a no-op for a stopped PTY', async () => {
  const h = await fixture();
  await h.exit(0);
  await h.runtime.resume(h.session.id);
  const task = await h.runtime.send(h.session.id, 'input after explicit resume');
  expect(task.status).toBe('failed');
  expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt?.state).toBe('settled');
  expect(h.drivers).toHaveLength(2);
  expect(h.writeInput).toHaveBeenCalledOnce();
});

it('keeps an exit during submission authorization explicitly unsubmitted', async () => {
  let h!: Awaited<ReturnType<typeof fixture>>;
  h = await fixture({ authorizeTask: async (_session, _task, phase) => { if (phase === 'submit') await h.exit(0); } });
  const task = await h.runtime.send(h.session.id, 'must not submit');
  expect(task.status).toBe('failed');
  expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt).toMatchObject({ state: 'settled', submissionState: 'not_submitted', outcome: 'failed' });
  expect(h.writeInput).not.toHaveBeenCalled();
  expect(h.drivers).toHaveLength(1);
});

it('retains an already submitted turn as unknown and never replays it after exit', async () => {
  const h = await fixture();
  // Hold the real adapter write before it reaches the backend, after Runtime's
  // durable intent. This is deliberately uncertain and must never be retried.
  let reject!: (error: Error) => void;
  h.writeInput.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = h.runtime.send(h.session.id, 'uncertain input');
  await vi.waitFor(() => expect(h.writeInput).toHaveBeenCalledOnce());
  await h.exit(0);
  reject(new Error('exited'));
  const task = await pending;
  const before = h.repos.execution.getTaskExecution(task.id)!;
  expect(task.status).toBe('reconcile_required');
  expect(before.currentAttempt).toMatchObject({ state: 'reconcile_required', submissionState: 'intent_recorded' });
  const queued = await h.runtime.dispatch(h.session.id, 'later input');
  expect(h.repos.execution.getTaskExecution(queued.id)?.attempts).toHaveLength(0);
  expect(h.repos.execution.getTaskExecution(task.id)?.currentAttempt?.attemptId).toBe(before.currentAttempt?.attemptId);
  expect(h.drivers).toHaveLength(1);
  expect(h.writeInput).toHaveBeenCalledOnce();
});
