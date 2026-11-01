import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositories } from '@dutydeck/storage';
import { readTaskReport, writeTaskReport, type AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture(holdFirst?: Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'report-maintenance-'));
  const repos = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const warn = vi.fn(); const send = vi.fn();
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, log: { warn },
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_a, _p, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true,
      interrupt: async () => {}, send: async prompt => { send(prompt); if (prompt === 'first') await holdFirst; emit({ type: 'text', data: { text: 'done' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); } }) });
  const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await runtime.shutdown(); repos.close(); };
  cleanups.push(async () => { await close(); await rm(cwd, { recursive: true, force: true }); });
  return { repos, runtime, session, send, warn, close, cwd, agent };
}
it('keeps scheduling an accepted task when clearing the prior report cannot be written', async () => {
  const h = await fixture(); const first = await h.runtime.send(h.session.id, 'first');
  await writeTaskReport(h.repos.config, { schemaVersion: 1, sessionId: h.session.id, taskId: first.id, status: 'waiting', question: '继续吗？', reportedAt: new Date().toISOString() });
  const cas = h.repos.config.compareAndSet!.bind(h.repos.config);
  vi.spyOn(h.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
    if (key === 'task_report/' + first.id) throw new Error('injected report clear failure');
    return cas(key, expected, value);
  });
  const next = await h.runtime.send(h.session.id, 'next');
  expect(next.status).toBe('completed'); expect(h.send).toHaveBeenCalledTimes(2); expect(h.warn).toHaveBeenCalled();
  expect((await readTaskReport(h.repos.config, first.id))?.clearedAt).toBeUndefined();
  expect(await h.runtime.getSessionTaskReport(h.session.id)).toBeUndefined();
});
it('does not fail execution when report reads fail only after the task is running', async () => {
  const h = await fixture(); const get = h.repos.config.get.bind(h.repos.config);
  vi.spyOn(h.repos.config, 'get').mockImplementation(async key => {
    if (key.startsWith('task_report/') && h.runtime.getActiveTaskContext(h.session.id)) throw new Error('injected executing report read failure');
    return get(key);
  });
  expect((await h.runtime.send(h.session.id, 'work')).status).toBe('completed');
  expect(h.send).toHaveBeenCalledOnce(); expect(h.warn).toHaveBeenCalled();
});
it('reads and clears report state without materializing session task history over 100 turns', async () => {
  const h = await fixture(); const all = vi.spyOn(h.repos.tasks, 'listBySession');
  const get = vi.spyOn(h.repos.config, 'get');
  for (let n = 0; n < 100; n++) expect((await h.runtime.send(h.session.id, 'round ' + n)).status).toBe('completed');
  console.log('report-maintenance-100-turns', { fullHistoryReads: all.mock.calls.length, reportReads: get.mock.calls.filter(([key]) => key.startsWith('task_report/')).length });
  expect(all).not.toHaveBeenCalled();
  expect(get.mock.calls.filter(([key]) => key.startsWith('task_report/')).length).toBeLessThanOrEqual(800);
  expect(h.send).toHaveBeenCalledTimes(100);
});


it('contains report getter failures without changing the next execution', async () => {
  const h = await fixture(); const first = await h.runtime.send(h.session.id, 'work');
  await writeTaskReport(h.repos.config, { schemaVersion: 1, sessionId: h.session.id, taskId: first.id, status: 'waiting', question: '继续吗？', reportedAt: new Date().toISOString() });
  const get = h.repos.config.get.bind(h.repos.config);
  vi.spyOn(h.repos.config, 'get').mockImplementation(async key => {
    if (key.startsWith('task_report/')) throw new Error('injected getter failure');
    return get(key);
  });
  await expect(h.runtime.getSessionTaskReport(h.session.id)).resolves.toBeUndefined();
  expect((await h.runtime.send(h.session.id, 'next')).status).toBe('completed');
  expect(h.warn).toHaveBeenCalled();
});

it('clears the old active report behind several queued receipts without reading history', async () => {
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  const h = await fixture(gate);
  try {
    await h.runtime.dispatch(h.session.id, 'first');
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    for (let n = 0; n < 3; n++) await h.runtime.dispatch(h.session.id, 'queued ' + n);
    const active = h.runtime.getActiveTaskContext(h.session.id)!;
    await h.runtime.reportCurrentTask(h.session.id, { status: 'waiting', question: '仍需决定吗？' }, active);
    const history = vi.spyOn(h.repos.tasks, 'listBySession');
    await h.runtime.dispatch(h.session.id, 'invalidate the active report');
    expect((await readTaskReport(h.repos.config, active.taskId))?.clearedAt).toBeTruthy();
    expect(await h.runtime.getSessionTaskReport(h.session.id)).toBeUndefined();
    expect(history).not.toHaveBeenCalled();
  } finally { release(); }
});

it.each([false, true])('clears persisted reports after a real reopen (reference present: %s)', async indexed => {
  const h = await fixture(); const first = await h.runtime.send(h.session.id, 'first');
  const report = { schemaVersion: 1 as const, sessionId: h.session.id, taskId: first.id, status: 'waiting' as const, question: '继续吗？', reportedAt: new Date().toISOString() };
  if (indexed) await writeTaskReport(h.repos.config, report);
  else await h.repos.config.set('task_report/' + first.id, JSON.stringify(report));
  await h.close();
  const repos = createRepositories(join(h.cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }) });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); });
  await runtime.initialize([h.agent]);
  expect(await runtime.getSessionTaskReport(h.session.id)).toEqual(report);
  await runtime.stop(h.session.id, { kind: 'installation_owner', id: 'installation_owner' });
  expect((await readTaskReport(repos.config, first.id))?.clearedAt).toBeTruthy();
  expect(await runtime.getSessionTaskReport(h.session.id)).toBeUndefined();
});
