import { defaultDriverProviders } from '../../../../apps/server/src/driver-providers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, dutydeckSessionKinds } from '@dutydeck/shared';
import { createAcceptPrompt, DutydeckRuntime, RuntimeEventBus, type ActiveTaskContext } from '../index.js';

it('awaits every host before plugins, including when a host fails', async () => {
  const events = new RuntimeEventBus();
  const order: string[] = [];
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const unsubscribe = events.subscribe('plugin', event => { order.push(event.type); });
  events.subscribe('host', async () => { order.push('host'); await paused; throw new Error('observer failed'); });
  events.subscribe('host', () => { order.push('second'); });
  const event = { type: 'matter.session' as const, sessionId: 'sample', input: { title: 'example' } };
  const dispatch = events.publish(event);
  expect(order).toEqual(['host']);
  release();
  await expect(dispatch).rejects.toThrow('observer failed');
  expect(order).toEqual(['host', 'second', 'matter.session']);
  unsubscribe();
  await expect(events.publish(event)).rejects.toThrow('observer failed');
  expect(order.slice(3)).toEqual(['host', 'second']);
});

it('delivers the active attempt to the assembler and holds settlement only for the end snapshot', async () => {
  const events = new RuntimeEventBus();
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-host-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const order: string[] = [];
  const assembled: Array<ActiveTaskContext | undefined> = [];
  let finishSnapshot!: () => void, finishDelivery!: () => void;
  const snapshot = new Promise<void>(resolve => { finishSnapshot = resolve; });
  const delivery = new Promise<void>(resolve => { finishDelivery = resolve; });
  events.subscribe('plugin', event => { if (event.type === 'task.settled') order.push('plugin settled'); });
  events.subscribe('host', async event => {
    if (event.type === 'task.settled') { order.push('host settled'); await delivery; }
    if (event.type === 'turn.ended') order.push('ended');
  });
  const runtime = new DutydeckRuntime(repos, {
    providers: defaultDriverProviders(),
    events,
    beforeSettlement: async () => { order.push('snapshot'); await snapshot; },
    launchContext: {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_agent, _protocol, emit) => ({
        start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true,
        send: async () => { emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }
      })
    },
    promptAssembler: {
      atAccept: createAcceptPrompt(),
      atExecute: (_session, prompt, _context, active) => { assembled.push(active); return prompt; }
    }
  });
  try {
    await runtime.initialize([agentConfigSchema.parse({ id: 'fixture', name: 'Fixture', command: process.execPath, cwd, protocol: 'acp' })]);
    const session = await runtime.start({ agentId: 'fixture' });
    const sent = runtime.send(session.id, 'request', 'request', undefined, 'installation_owner');
    await vi.waitFor(() => expect(order).toEqual(['snapshot']));
    const [running] = await runtime.getTasks(session.id);
    expect(running!.status).toBe('running');
    expect(assembled).toEqual([{ taskId: running!.id, attemptId: repos.execution.getTaskExecution(running!.id)!.currentAttempt!.attemptId, actorId: 'installation_owner' }]);
    finishSnapshot();
    expect((await sent).status).toBe('completed');
    await vi.waitFor(() => expect(order).toEqual(['snapshot', 'ended', 'host settled']));
    finishDelivery();
    await vi.waitFor(() => expect(order.at(-1)).toBe('plugin settled'));
  } finally { finishSnapshot(); finishDelivery(); await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); }
});

it('uses the registered source and ID pattern for admission and reuse', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'runtime-kind-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const spec = { ...dutydeckSessionKinds.workItem, source: 'sample-job', idPattern: /^sample_[0-9]+$/g };
  const validate = vi.spyOn(spec, 'validate');
  const runtime = new DutydeckRuntime(repos, {
    providers: defaultDriverProviders(),
    sessionKinds: { ...dutydeckSessionKinds, workItem: spec },
    launchContext: {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: () => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, send: async () => {}, isStopped: async () => true })
    }
  });
  try {
    await runtime.initialize([agentConfigSchema.parse({ id: 'fixture', name: 'Fixture', command: process.execPath, cwd, protocol: 'acp' })]);
    const input = { agentId: 'fixture', source: 'sample-job', sourceId: 'one' };
    const admit = vi.fn(async () => {});
    await expect(runtime.start(input)).rejects.toMatchObject({ code: 'INVALID_WORK_SESSION' });
    await expect(runtime.startWorkItemSession(input, 'ses_work_' + 'a'.repeat(64), admit)).rejects.toMatchObject({ code: 'INVALID_WORK_SESSION' });
    expect(admit).not.toHaveBeenCalled();
    const session = await runtime.startWorkItemSession(input, 'sample_1', admit);
    expect((await runtime.startWorkItemSession(input, session.id, admit)).id).toBe(session.id);
    expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({ id: session.id }), input);
    await expect(runtime.setSessionName(session.id, 'new name')).rejects.toMatchObject({ code: 'INVALID_WORK_SESSION' });
  } finally { await runtime.shutdown(); repos.close(); await rm(cwd, { recursive: true, force: true }); }
});
