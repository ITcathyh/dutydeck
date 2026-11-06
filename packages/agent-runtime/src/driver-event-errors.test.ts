import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, NormalizedDriverEvent } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(onSend?: (emit: (event: NormalizedDriverEvent) => void, round: number) => void) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(() => repos.close());
  const log = { warn: vi.fn(), info: vi.fn() };
  let emit!: (event: NormalizedDriverEvent) => void, round = 0;
  const driver: AgentDriver = {
    start: vi.fn(async () => {}), resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), stop: vi.fn(async () => {}), isStopped: async () => true,
    send: vi.fn(async () => { onSend?.(emit, ++round); emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
  };
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, log, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (_agent, _protocol, onEvent) => { emit = onEvent; return driver; } });
  cleanup.push(() => runtime.shutdown());
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  return { runtime, repos, driver, log, session, emit: (event: NormalizedDriverEvent) => emit(event) };
}

it('an idle event that cannot be stored is logged and does not fail the next unrelated message', async () => {
  const h = await fixture();
  expect((await h.runtime.send(h.session.id, 'first')).status).toBe('completed');
  h.emit({ type: 'status', data: { state: 'turn_usage', cost: Number.NaN } });
  await vi.waitFor(() => expect(h.log.warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: h.session.id, eventType: 'status' }), expect.any(String)));
  expect((await h.runtime.send(h.session.id, 'second')).status).toBe('completed');
  expect(h.driver.send).toHaveBeenCalledTimes(2);
});

it('an event of the running turn that cannot be stored still leaves that turn unverified', async () => {
  const h = await fixture((emit, round) => { if (round === 1) emit({ type: 'status', data: { state: 'turn_usage', cost: Number.NaN } }); });
  expect((await h.runtime.send(h.session.id, 'first')).status).toBe('reconcile_required');
});
