import { afterEach, expect, it, vi } from 'vitest';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import { RelayAskBroker, RelayCapabilityRegistry } from '@dutydeck/relay';
import type { AgentConfig, AgentDriver, AgentEvent, NormalizedDriverEvent } from '@dutydeck/shared';
import { buildApp } from './app.js';
import { createRelayAskStore } from './relay-ask-store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let emit!: (event: NormalizedDriverEvent) => void;
  let finish: (() => void) | undefined;
  const driver: AgentDriver = {
    start: async () => {},
    send: async () => { await new Promise<void>(resolve => { finish = resolve; }); emit({ type: 'completed', data: { stopReason: 'cancelled' } }); },
    interrupt: async () => { finish?.(); }, stop: async () => { finish?.(); },
    isStopped: async () => true, resume: async () => {}
  };
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _protocol, onEvent) => { emit = onEvent; return driver; }
  });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  const broker = new RelayAskBroker({ publish: async (id, input) => { await runtime.publishSessionEvent(id, 'text', { relay: input.kind, text: input.text, askId: input.askId }); } }, createRelayAskStore(repos.config));
  const capabilities = new RelayCapabilityRegistry({ get: id => runtime.getSession(id) }, 'http://localhost', 'test');
  const listeners = new Set<(event: AgentEvent) => unknown>();
  const subscribe = runtime.subscribe.bind(runtime);
  vi.spyOn(runtime, 'subscribe').mockImplementation((id, listener, options) => {
    listeners.add(listener);
    const unsubscribe = subscribe(id, listener, options);
    return () => { listeners.delete(listener); unsubscribe(); };
  });
  const app = await buildApp(runtime, { relay: { runtime, broker, capabilities } });
  cleanup.push(async () => { broker.close(); await broker.flush(); await app.close(); await runtime.shutdown(); repos.close(); });
  const dispatch = async () => {
    finish = undefined;
    await runtime.dispatch(session.id, 'wait for a question');
    await vi.waitFor(() => expect(finish).toBeDefined());
    return runtime.getActiveTaskContext(session.id)!;
  };
  const ask = (question: string) => app.inject({ method: 'POST', url: `/api/relay/sessions/${session.id}/ask`, headers: { authorization: `Bearer ${capabilities.tokenFor(session.id)}` }, payload: { question, timeoutMs: 60_000 } }).then(response => response.json());
  return { repos, runtime, session, broker, app, dispatch, ask, listeners, capabilities };
}

it('cancels an interrupted task question while the reusable session becomes idle, and rejects late answers', async () => {
  const f = await fixture();
  const owner = await f.dispatch();
  const result = f.ask('old task question');
  await vi.waitFor(() => expect(f.broker.listPending()).toHaveLength(1));
  const ask = f.broker.listPending()[0]!;
  await f.runtime.interrupt(f.session.id);
  await vi.waitFor(async () => expect((await f.runtime.getTasks(f.session.id)).find(task => task.id === owner.taskId)?.status).toBe('interrupted'));
  expect((await f.runtime.getSession(f.session.id))?.state).toBe('idle');
  await vi.waitFor(() => expect(f.broker.listPending()).toEqual([]));
  expect(await result).toMatchObject({ status: 'cancelled' });
  expect(await createRelayAskStore(f.repos.config).get(ask.id)).toMatchObject({ status: 'cancelled' });
  const late = await f.app.inject({ method: 'POST', url: `/api/relay/sessions/${f.session.id}/asks/${ask.id}/answer`, payload: { answer: 'late' } });
  expect(late.statusCode).toBe(409);
});

it('does not cancel a new task question when an old task event arrives late', async () => {
  const f = await fixture();
  const old = await f.dispatch();
  await f.runtime.interrupt(f.session.id);
  await vi.waitFor(() => expect(f.runtime.getActiveTaskContext(f.session.id)).toBeUndefined());
  const next = await f.dispatch();
  const result = f.ask('next task question');
  await vi.waitFor(() => expect(f.broker.listPending()).toHaveLength(1));
  const oldEvent = (await f.runtime.getEvents(f.session.id)).find(event => event.type === 'task' && event.taskId === old.taskId && (event.data as { task?: { status: string } }).task?.status === 'interrupted')!;
  expect(oldEvent).toBeDefined();
  for (const listener of f.listeners) {
    await listener(oldEvent);
    // A retry of the same task must also reject a previous attempt's event.
    await listener({ ...oldEvent, taskId: next.taskId, data: { task: { id: next.taskId, status: 'interrupted' } } });
  }
  const pending = f.broker.listPending()[0]!;
  expect(pending).toMatchObject({ taskId: next.taskId, attemptId: next.attemptId });
  await f.broker.answer(pending.id, 'new answer');
  expect(await result).toMatchObject({ status: 'answered', answer: 'new answer' });
});

it.each(['stop', 'archive'] as const)('cancels a live question through runtime %s', async action => {
  const f = await fixture();
  // Archive requires no unresolved attempt; idle sessions can still have asks.
  if (action === 'stop') await f.dispatch();
  const result = f.ask(`${action} question`);
  await vi.waitFor(() => expect(f.broker.listPending()).toHaveLength(1));
  await f.runtime[action](f.session.id);
  await vi.waitFor(() => expect(f.broker.listPending()).toEqual([]));
  expect(await result).toMatchObject({ status: 'cancelled' });
});


it('does not publish an old task question if interruption wins while capability resolution is awaiting', async () => {
  const f = await fixture();
  const owner = await f.dispatch();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const resolve = f.capabilities.resolve.bind(f.capabilities);
  let calls = 0;
  vi.spyOn(f.capabilities, 'resolve').mockImplementation(async (...args) => {
    if (++calls === 2) await gate;
    return resolve(...args);
  });
  const result = f.ask('must not publish');
  try {
    await vi.waitFor(() => expect(calls).toBe(2));
    await f.runtime.interrupt(f.session.id);
    await vi.waitFor(async () => expect((await f.runtime.getTasks(f.session.id)).find(task => task.id === owner.taskId)?.status).toBe('interrupted'));
    release();
    expect(await result).toMatchObject({ status: 'cancelled' });
    expect(f.broker.listPending()).toEqual([]);
    expect((await f.runtime.getEvents(f.session.id)).some(event => (event.data as { relay?: string }).relay === 'ask')).toBe(false);
  } finally { release(); }
});
