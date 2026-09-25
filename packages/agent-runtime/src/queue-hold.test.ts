import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' })) {
  let emit!: (event: any) => void;
  const gates = new Map<string, Promise<void>>();
  const driver: AgentDriver = {
    start: vi.fn(async () => {}),
    send: vi.fn(async (prompt: string) => {
      await gates.get(prompt);
      emit({ type: 'text', data: { text: `answer:${prompt}` } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    }),
    interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {})
  };
  const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (_agent, _protocol, onEvent) => { emit = onEvent; return driver; } });
  return { repos, runtime, driver, gates };
}

const sent = (driver: AgentDriver) => (driver.send as ReturnType<typeof vi.fn>).mock.calls.map(call => call[0]);

describe('restart drain queue hold', () => {
  it('keeps new tasks queued while held and runs them after release', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    h.runtime.setQueueHeld(true);
    expect(h.runtime.isQueueHeld()).toBe(true);
    const task = await h.runtime.dispatch(session.id, 'held');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.driver.send).not.toHaveBeenCalled();
    expect((await h.runtime.getTasks(session.id)).find(item => item.id === task.id)?.status).toBe('queued');
    expect(h.runtime.getRunningTaskCount()).toBe(0);

    h.runtime.setQueueHeld(false);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(item => item.id === task.id)?.status).toBe('completed'));
    expect(sent(h.driver)).toEqual(['held']);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('lets the running turn finish but does not claim the next queued task until release', async () => {
    const h = harness();
    const gate = deferred();
    h.gates.set('first', gate.promise);
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const first = await h.runtime.dispatch(session.id, 'first');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalledWith('first'));
    const second = await h.runtime.dispatch(session.id, 'second');
    h.runtime.setQueueHeld(true);
    expect(h.runtime.getRunningTaskCount()).toBe(1);

    gate.resolve();
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(item => item.id === first.id)?.status).toBe('completed'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sent(h.driver)).toEqual(['first']);
    expect((await h.runtime.getTasks(session.id)).find(item => item.id === second.id)?.status).toBe('queued');

    h.runtime.setQueueHeld(false);
    await vi.waitFor(async () => expect((await h.runtime.getTasks(session.id)).find(item => item.id === second.id)?.status).toBe('completed'));
    expect(sent(h.driver)).toEqual(['first', 'second']);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('leaves held tasks durable for the next process to run', async () => {
    const first = harness();
    await first.runtime.initialize([agent]);
    const session = await first.runtime.start({ agentId: 'mock' });
    first.runtime.setQueueHeld(true);
    const task = await first.runtime.dispatch(session.id, 'after restart');
    await first.runtime.shutdown();
    expect(first.driver.send).not.toHaveBeenCalled();

    const next = harness(first.repos);
    await next.runtime.initialize([agent]);
    await vi.waitFor(async () => expect((await next.runtime.getTasks(session.id)).find(item => item.id === task.id)?.status).toBe('completed'));
    expect(sent(next.driver)).toEqual(['after restart']);
    await next.runtime.shutdown(); first.repos.close();
  });
});
