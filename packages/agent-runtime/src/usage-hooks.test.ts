import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver } from '@dutydeck/shared';
import { RuntimeError } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

function harness(options: Pick<NonNullable<ConstructorParameters<typeof DutydeckRuntime>[1]>, 'admitTask' | 'recordUsage'>) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let emit!: (event: any) => void;
  const driver: AgentDriver = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {
      emit({ type: 'text', data: { text: 'done' } });
      emit({ type: 'status', data: { state: 'usage', used: 10, size: 100 } });
      emit({ type: 'status', data: { state: 'turn_usage', usageRef: 'req_1', breakdown: { inputTokens: 5 }, cost: { amount: 0.1, currency: 'USD' } } });
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    }),
    interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true, stop: vi.fn(async () => {})
  };
  const runtime = new DutydeckRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (_agent, _protocol, onEvent) => { emit = onEvent; return driver; }, ...options });
  return { repos, runtime, driver };
}

describe('runtime usage hooks', () => {
  it('hands the turn usage reading and the completion to the host after both are stored, scoped to the attempt', async () => {
    const calls: Array<{ attempt: unknown; reading: unknown; stored: boolean }> = [];
    let h!: ReturnType<typeof harness>;
    h = harness({
      recordUsage: async (session, attempt, reading) => {
        const events = await h.repos.events.list(session.id);
        calls.push({ attempt, reading, stored: !reading || events.some(event => (event.data as any)?.state === 'turn_usage') });
      }
    });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const result = await h.runtime.send(session.id, 'work');
    expect(result.status).toBe('completed');
    const task = (await h.runtime.getTasks!(session.id))[0]!;
    const attemptId = h.repos.execution.getTaskExecution(task.id)!.currentAttempt!.attemptId;
    expect(calls).toEqual([
      { attempt: { taskId: task.id, attemptId }, reading: { state: 'turn_usage', usageRef: 'req_1', breakdown: { inputTokens: 5 }, cost: { amount: 0.1, currency: 'USD' } }, stored: true },
      { attempt: { taskId: task.id, attemptId }, reading: undefined, stored: true }
    ]);
    await h.runtime.shutdown(); h.repos.close();
  });

  it('does not let a failing usage hook fail the turn', async () => {
    const h = harness({ recordUsage: async () => { throw new Error('ledger unavailable'); } });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    expect((await h.runtime.send(session.id, 'work')).status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('rejects a new task before acceptance but replays an accepted one without asking again', async () => {
    let refuse = false;
    const admitTask = vi.fn(async () => { if (refuse) throw new RuntimeError('USAGE_CAP_EXCEEDED', '本群本月成本上限已用完', 429); });
    const h = harness({ admitTask });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const accepted = await h.runtime.dispatch(session.id, 'first', 'queue', 'first', undefined, undefined, 'key-1');
    expect(admitTask).toHaveBeenCalledTimes(1);
    expect(admitTask.mock.calls[0]![1]).toMatchObject({ namespace: 'runtime', key: 'key-1', sessionId: session.id });
    refuse = true;
    await expect(h.runtime.dispatch(session.id, 'second', 'queue', 'second', undefined, undefined, 'key-2')).rejects.toMatchObject({ code: 'USAGE_CAP_EXCEEDED' });
    expect((await h.runtime.getTasks!(session.id)).map(task => task.id)).toEqual([accepted.id]);
    const replayed = await h.runtime.dispatch(session.id, 'first', 'queue', 'first', undefined, undefined, 'key-1');
    expect(replayed).toMatchObject({ id: accepted.id, replayed: true });
    expect(admitTask).toHaveBeenCalledTimes(2);
    await h.runtime.shutdown(); h.repos.close();
  });
});
