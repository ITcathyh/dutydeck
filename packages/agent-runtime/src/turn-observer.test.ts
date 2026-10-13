import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

function harness(observeTurn: NonNullable<ConstructorParameters<typeof DutydeckRuntime>[1]>['observeTurn'], send?: () => Promise<void>) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const order: string[] = [];
  let emit!: (event: any) => void;
  const driver: AgentDriver = {
    start: vi.fn(async () => {}),
    send: vi.fn(send ?? (async () => {
      order.push('send');
      emit({ type: 'text', data: { text: 'done' } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    })),
    interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {})
  };
  const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (_agent, _protocol, onEvent) => { emit = onEvent; return driver; }, observeTurn: async (session, taskId, phase) => { order.push(phase); await observeTurn?.(session, taskId, phase); } });
  return { repos, runtime, order };
}

describe('runtime observeTurn', () => {
  it('snapshots before the driver gets the prompt and after it returns, before the task settles', async () => {
    const settledAtEnd: string[] = [];
    let h!: ReturnType<typeof harness>;
    h = harness(async (session, taskId, phase) => {
      if (phase === 'end') settledAtEnd.push(h.repos.execution.getTaskExecution(taskId)!.task.status);
    });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const result = await h.runtime.send(session.id, 'work');
    expect(result.status).toBe('completed');
    expect(h.order).toEqual(['start', 'send', 'end']);
    expect(settledAtEnd).toEqual(['running']);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not let a failing observer fail the turn, and still takes the end snapshot when the driver fails', async () => {
    const h = harness(async () => { throw new Error('snapshot failed'); });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    expect((await h.runtime.send(session.id, 'work')).status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();

    const failing = harness(undefined, async () => { throw new Error('driver crashed'); });
    await failing.runtime.initialize([agent]);
    const other = await failing.runtime.start({ agentId: 'mock' });
    await failing.runtime.send(other.id, 'work').catch(() => undefined);
    expect(failing.order).toEqual(['start', 'end']);
    await failing.runtime.shutdown(); failing.repos.close();
  });
});
