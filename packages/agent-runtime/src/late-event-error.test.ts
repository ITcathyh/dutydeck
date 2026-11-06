import { expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver, NormalizedDriverEvent } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

it('an event that fails to record after the turn was flushed does not fail the next, unrelated message', async () => {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let emit!: (event: NormalizedDriverEvent) => void, late = true;
  const log = { warn: vi.fn(), info: vi.fn() };
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0, log,
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    // Between the turn's last event flush and its settlement, the driver delivers one more event.
    observeTurn: async (_session, _taskId, phase) => {
      if (phase !== 'end' || !late) return;
      late = false;
      emit({ type: 'text', data: { text: 'late' } });
      await new Promise(resolve => setTimeout(resolve, 20));
    },
    driverFactory: (_agent, _protocol, onEvent) => {
      emit = onEvent;
      const driver: AgentDriver = {
        start: vi.fn(async () => {}), resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), stop: vi.fn(async () => {}), isStopped: async () => true,
        send: vi.fn(async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
      };
      return driver;
    },
  });
  const internal = runtime as unknown as { emit: (...args: unknown[]) => Promise<unknown> };
  const original = internal.emit.bind(runtime);
  vi.spyOn(internal, 'emit').mockImplementation(async (...args: unknown[]) => {
    if ((args[2] as { text?: string } | undefined)?.text === 'late') throw new Error('late event write failed');
    return original(...args);
  });
  try {
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });
    expect((await runtime.send(session.id, 'first')).status).toBe('completed');
    expect((await runtime.send(session.id, 'second')).status).toBe('completed');
    expect(log.warn.mock.calls.some(([, message]) => /could not be recorded/.test(String(message)))).toBe(true);
  } finally { await runtime.shutdown(); repos.close(); }
});
