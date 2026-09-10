import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DriverDetachedError, DriverRecoveryError, type AgentConfig, type AgentDriver, type DriverFactory, type DriverTurnRecovery, type NormalizedDriverEvent } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const agent: AgentConfig = { id: 'persistent', name: 'Persistent', command: 'unused', args: [], protocol: 'pty-cli', cwd: '/tmp', env: {}, permissionMode: 'full-trust', timeout: 30, capabilities: { pause: false, resume: true }, builtin: false };
const directories: string[] = [];
const runtimes: DutydeckRuntime[] = [];
const repositories: ReturnType<typeof createRepositories>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const repos of repositories.splice(0)) repos.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function persistentTurn() {
  const log: NormalizedDriverEvent[] = [];
  const prompts: string[] = [];
  let attached: { emit(event: NormalizedDriverEvent): void; resolve(): void; reject(error: Error): void } | undefined;
  let completed = false;
  let turnId = '';
  let serial = 0;
  const drivers: AgentDriver[] = [];
  const factory: DriverFactory = (_agent, _protocol, emit) => {
    let prepared: DriverTurnRecovery;
    const wait = () => new Promise<void>((resolve, reject) => { attached = { emit, resolve, reject }; });
    const driver: AgentDriver = {
      start: vi.fn(async () => {}), resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
      checkpoint: () => (prepared = { kind: 'pty-jsonl-v1', turnId: 'turn_' + ++serial, transcript: { path: '/owned/transcript', offset: log.length } }),
      send: vi.fn(async prompt => { prompts.push(prompt); turnId = prepared.turnId; completed = false; return wait(); }),
      recover: vi.fn(async state => {
        if (state.turnId !== turnId) throw new DriverRecoveryError('原任务提交状态无法确认，未重新发送指令');
        const pending = wait();
        for (const event of log.slice(state.transcript.offset)) emit(event);
        if (completed) { emit({ type: 'completed', data: { stopReason: 'end_turn' } }); attached!.resolve(); }
        return pending;
      }),
      stop: vi.fn(async () => { attached?.reject(new DriverDetachedError()); attached = undefined; })
    };
    drivers.push(driver);
    return driver;
  };
  return {
    factory, prompts, drivers,
    publish(text: string) {
      const event: NormalizedDriverEvent = { type: 'text', data: { text }, sourceId: 'record_' + log.length };
      log.push(event); attached?.emit(event);
    },
    complete() { completed = true; attached?.emit({ type: 'completed', data: { stopReason: 'end_turn' } }); attached?.resolve(); },
    repeatFirst() { attached?.emit(log[0]!); }
  };
}

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-task-recovery-'));
  directories.push(dir);
  return join(dir, 'dutydeck.db');
}

function open(database: string, factory: DriverFactory, options: ConstructorParameters<typeof DutydeckRuntime>[1] = {}) {
  const repos = createRepositories(database);
  const runtime = new DutydeckRuntime(repos, { driverFactory: factory, probe: () => ({ available: true, protocol: 'pty-cli', pause: false, resume: true }), ...options });
  repositories.push(repos); runtimes.push(runtime);
  return { repos, runtime };
}

async function close(handle: ReturnType<typeof open>) {
  await handle.runtime.shutdown();
  handle.repos.close();
  runtimes.splice(runtimes.indexOf(handle.runtime), 1);
  repositories.splice(repositories.indexOf(handle.repos), 1);
}

describe('persistent task recovery across a reopened database', () => {
  it.each([false, true])('reattaches the same task without duplicate output or submissions (completed offline: %s)', async offline => {
    const file = database(); const backend = persistentTurn();
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    const task = await first.runtime.dispatch(session.id, 'original prompt');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['original prompt']));
    backend.publish('before restart');
    await vi.waitFor(async () => expect((await first.runtime.getEvents(session.id)).some(event => (event.data as any)?.text === 'before restart')).toBe(true));
    backend.repeatFirst();
    await close(first);
    backend.publish('after restart');
    if (offline) backend.complete();

    const second = open(file, backend.factory);
    await second.runtime.initialize([agent]);
    await vi.waitFor(() => expect(backend.drivers[1]!.recover).toHaveBeenCalledOnce());
    if (!offline) {
      expect((await second.runtime.getTasks(session.id))[0]?.status).toBe('running');
      backend.complete();
    }
    await vi.waitFor(async () => expect((await second.runtime.getTasks(session.id))[0]?.status).toBe('completed'));
    expect(backend.prompts).toEqual(['original prompt']);
    expect(backend.drivers[1]!.start).not.toHaveBeenCalled();
    expect((await second.runtime.getTasks(session.id)).map(item => item.id)).toEqual([task.id]);
    const events = await second.runtime.getEvents(session.id);
    expect(events.filter(event => event.type === 'text').map(event => (event.data as any).text)).toEqual(['original prompt', 'before restart', 'after restart']);
    expect(events.filter(event => event.type === 'completed')).toHaveLength(1);
    expect(events.some(event => event.type === 'error')).toBe(false);
    expect((await second.runtime.getTasks(session.id))[0]).not.toHaveProperty('executionContext');
  });

  it('leaves queued work pending during shutdown and waits for the recovered task before draining it', async () => {
    const file = database(); const backend = persistentTurn();
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    const queued = await first.runtime.dispatch(session.id, 'second');
    await close(first);
    const second = open(file, backend.factory);
    expect((await second.runtime.getTasks(session.id)).map(task => task.status)).toEqual(['running', 'queued']);
    await second.runtime.initialize([agent]);
    await vi.waitFor(() => expect(backend.drivers[1]!.recover).toHaveBeenCalledOnce());
    expect(backend.prompts).toEqual(['first']);
    backend.publish('first answer'); backend.complete();
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first', 'second']));
    backend.publish('second answer'); backend.complete();
    await vi.waitFor(async () => expect((await second.runtime.getTasks(session.id)).find(task => task.id === queued.id)?.status).toBe('completed'));
  });

  it('preserves an unsubmitted queued task when shutdown races with authorization', async () => {
    const file = database(); const backend = persistentTurn();
    let authorize!: () => void;
    const gate = new Promise<void>(resolve => { authorize = resolve; });
    const first = open(file, backend.factory, { authorizeExecution: () => gate });
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    await first.runtime.dispatch(session.id, 'not yet submitted');
    await vi.waitFor(async () => expect((await first.runtime.getTasks(session.id))[0]?.status).toBe('queued'));
    const stopped = first.runtime.shutdown();
    authorize(); await stopped;
    expect(backend.prompts).toEqual([]);
    expect((await first.runtime.getTasks(session.id))[0]?.status).toBe('queued');
  });

  it('does not replay the prompt or drain the queue when the original backend cannot be confirmed', async () => {
    const file = database(); const backend = persistentTurn();
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    await first.runtime.dispatch(session.id, 'second');
    await close(first);
    const second = open(file, (...args) => ({ ...backend.factory(...args), recover: async () => { throw new DriverRecoveryError('原终端已不存在，未重新发送指令'); } }));
    await second.runtime.initialize([agent]);
    await vi.waitFor(async () => expect((await second.runtime.getSession(session.id))?.state).toBe('stopped'));
    expect((await second.runtime.getTasks(session.id)).map(task => task.status)).toEqual(['interrupted', 'cancelled']);
    expect(backend.prompts).toEqual(['first']);
    expect(backend.drivers[1]!.start).not.toHaveBeenCalled();
  });

  it.each(['interrupting', 'interrupted'] as const)('does not recover a turn the user was already stopping (%s)', async state => {
    const file = database(); const backend = persistentTurn();
    const first = open(file, backend.factory);
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: agent.id });
    await first.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(backend.prompts).toEqual(['first']));
    await close(first);
    const second = open(file, backend.factory);
    await second.repos.sessions.save({ ...(await second.repos.sessions.get(session.id))!, state });
    await second.runtime.initialize([agent]);
    expect((await second.runtime.getTasks(session.id))[0]?.status).toBe('interrupted');
    expect(second.runtime.getDriver(session.id)).toBeUndefined();
    expect(backend.prompts).toEqual(['first']);
  });
});

it('reattaches a completed terminal once after restart without starting or changing the task', async () => {
  const file = database();
  const backend = persistentTurn();
  const first = open(file, backend.factory);
  await first.runtime.initialize([agent]);
  const session = await first.runtime.start({ agentId: agent.id });
  session.state = 'completed';
  await first.repos.sessions.save(session);
  await close(first);
  const attached: AgentDriver = {
    start: vi.fn(async () => {}), resume: vi.fn(async () => {}), send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}), stop: vi.fn(async () => {}), attachTerminal: vi.fn(() => true)
  };
  const factory = vi.fn(() => attached);
  const second = open(file, factory);
  await second.runtime.initialize([agent]);
  const before = await second.runtime.getSession(session.id);
  expect(await Promise.all([second.runtime.getTerminalDriver(session.id), second.runtime.getTerminalDriver(session.id)])).toEqual([attached, attached]);
  expect(factory).toHaveBeenCalledOnce();
  expect(attached.attachTerminal).toHaveBeenCalledOnce();
  expect(attached.start).not.toHaveBeenCalled();
  expect(attached.resume).not.toHaveBeenCalled();
  expect(attached.send).not.toHaveBeenCalled();
  expect(await second.runtime.getSession(session.id)).toEqual(before);
});
