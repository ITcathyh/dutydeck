import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentDriver } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.useRealTimers(); });
const agent: AgentConfig = { id: 'mock', name: 'Mock', command: 'unused', args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(compact?: AgentDriver['compact']) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const order: string[] = [];
  let driver!: AgentDriver;
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (_agent, _protocol, emit) => {
    driver = { start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isStopped: async () => true, setModel: async () => {},
      send: vi.fn(async input => { order.push(typeof input === 'string' ? input : input.prompt); emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
      ...(compact ? { compact: vi.fn(async submission => { order.push('compact'); return compact(submission); }) } : {}) };
    return driver;
  } });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); });
  const dispatch = (prompt: string, hours?: number) => runtime.dispatch(session.id, prompt, 'queue', prompt, undefined, undefined, undefined, undefined, undefined, hours);
  const wait = async (id: string, status = 'completed') => vi.waitFor(async () => expect((await runtime.getTasks(session.id)).find(task => task.id === id)?.status).toBe(status));
  const old = await dispatch('old', 24); await wait(old.id);
  return { repos, runtime, session, driver, order, dispatch, wait };
}
describe('idle compaction at serialized task activation', () => {
  it('compacts once before the first queued message and runs both user prompts once', async () => {
    const gate = deferred();
    const h = await fixture(async () => { await gate.promise; return 'completed'; });
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'));
    const first = await h.dispatch('first', 24);
    await vi.waitFor(() => expect(h.order).toEqual(['old', 'compact']));
    const second = await h.dispatch('second', 24);
    expect(second.status).toBe('queued');
    gate.resolve(); await h.wait(first.id); await h.wait(second.id);
    expect(h.order).toEqual(['old', 'compact', 'first', 'second']);
  });
  it('ignores fresh sessions and disabled policy even after a configuration touch', async () => {
    const h = await fixture(async () => 'completed');
    const fresh = await h.dispatch('fresh', 24); await h.wait(fresh.id);
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'));
    const disabled = await h.dispatch('disabled'); await h.wait(disabled.id);
    expect(h.driver.compact).not.toHaveBeenCalled();
  });
  it('uses prior actual task completion rather than Session.updatedAt', async () => {
    const h = await fixture(async () => 'completed');
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'));
    await h.runtime.setModel(h.session.id, 'updated-model');
    const next = await h.dispatch('after config', 24); await h.wait(next.id);
    expect(h.order).toEqual(['old', 'compact', 'after config']);
  });
  it('falls back safely when native compact is unsupported or explicitly failed', async () => {
    const h = await fixture(async () => 'failed');
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'));
    const next = await h.dispatch('after failure', 24); await h.wait(next.id);
    expect(h.order).toEqual(['old', 'compact', 'after failure']);
    delete h.driver.compact;
    vi.setSystemTime(new Date('2026-10-03T02:00:00Z'));
    const unsupported = await h.dispatch('unsupported', 24); await h.wait(unsupported.id);
    expect((await h.runtime.getEvents(h.session.id)).some(event => (event.data as any)?.phase === 'unsupported')).toBe(true);
  });
  it('preserves blocking semantics when compact execution is uncertain', async () => {
    const h = await fixture(async () => { throw new Error('transport lost'); });
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'));
    const next = await h.dispatch('must not send', 24); await h.wait(next.id, 'reconcile_required');
    expect(h.order).toEqual(['old', 'compact']);
  });
  it('honors durable interrupt intent between compact and the real prompt', async () => {
    const gate = deferred();
    const h = await fixture(async () => { await gate.promise; return 'completed'; });
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'));
    const next = await h.dispatch('must not send', 24);
    await vi.waitFor(() => expect(h.order).toEqual(['old', 'compact']));
    await h.runtime.interrupt(h.session.id, next.id);
    gate.resolve(); await h.wait(next.id, 'interrupted');
    expect(h.order).toEqual(['old', 'compact']);
    const successor = await h.dispatch('successor', 24); await h.wait(successor.id);
    expect(h.order).toEqual(['old', 'compact', 'successor']);
  });
});
