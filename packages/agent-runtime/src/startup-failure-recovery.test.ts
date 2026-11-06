import { afterEach, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver, type SessionNotice } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });

// 第 1 条完成 → 空闲回收驱动 → 第 2 条在任务里重新拉起 Agent，start() 抛错。
async function fixture(exitedAfterFailedStart: boolean) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  cleanup.push(() => repos.close());
  const log = { warn: vi.fn(), info: vi.fn() }, notices: SessionNotice[] = [], drivers: AgentDriver[] = [];
  const runtime = new DutydeckRuntime(repos, {
    cleanupIntervalMs: 0, driverIdleTimeoutMs: 10, log, onSessionNotice: (_session, notice) => { notices.push(notice); },
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _protocol, emit) => {
      const build = drivers.length + 1;
      const driver: AgentDriver = {
        start: vi.fn(async () => { if (build === 2) throw new Error(`start failed #${build}`); }), resume: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
        send: vi.fn(async () => { emit({ type: 'text', data: { text: 'answer' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
        stop: vi.fn(async () => {}), isStopped: async () => build !== 2 || exitedAfterFailedStart, prepareForIdleRetirement: async () => true,
      };
      drivers.push(driver); return driver;
    },
  });
  cleanup.push(() => runtime.shutdown());
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });
  expect((await runtime.send(session.id, 'first')).status).toBe('completed');
  await runtime.cleanupIdleDrivers(Date.now() + 100);
  expect(runtime.getDriver(session.id)).toBeUndefined();
  // 复核计时器在第 2 条失败时排上，要在那之前接管。
  if (!exitedAfterFailedStart) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  expect((await runtime.send(session.id, 'second')).status).toBe('failed');
  return { runtime, log, notices, drivers, session };
}

it('a driver whose startup failed and whose exit is proven does not block the next message', async () => {
  const h = await fixture(true);
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined();
  expect((await h.runtime.send(h.session.id, 'third')).status).toBe('completed');
  expect(h.drivers).toHaveLength(3);
  expect(h.drivers[1]!.stop).toHaveBeenCalledOnce();
});

it('a failed startup whose exit cannot be proven rejects new messages with the reason and recovers once a recheck proves exit', async () => {
  const h = await fixture(false);
  await expect(h.runtime.dispatch(h.session.id, 'third')).rejects.toMatchObject({ code: 'DRIVER_STOP_UNVERIFIED', message: expect.stringContaining('自动恢复') });
  expect((await h.runtime.getTasks(h.session.id)).map(task => task.status)).toEqual(['completed', 'failed']);
  await vi.advanceTimersByTimeAsync(46_000);
  expect(h.notices).toEqual([expect.objectContaining({ kind: 'stop_unverified', sessionIds: [h.session.id], message: expect.stringContaining('启动') })]);
  h.drivers[1]!.isStopped = async () => true;
  await vi.advanceTimersByTimeAsync(90_000);
  vi.useRealTimers();
  expect(h.runtime.getDriverStopBlock(h.session.id)).toBeUndefined();
  expect((await h.runtime.send(h.session.id, 'after recovery')).status).toBe('completed');
  expect(h.drivers).toHaveLength(3);
});
