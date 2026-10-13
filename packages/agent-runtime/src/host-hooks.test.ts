import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver, type RuntimeOptions } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };

function harness(hostOptions: Pick<RuntimeOptions, 'reviewPermission' | 'onTaskSettled'>) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let emit!: (event: any) => void;
  const driver: AgentDriver = {
    start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), isStopped: async () => true,
    stop: vi.fn(async () => {}), resolvePermission: vi.fn(async () => true), setModel: vi.fn(async () => {}), setReasoningEffort: vi.fn(async () => {}), setPermissionMode: vi.fn()
  };
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_agent, _p, onEvent) => { emit = onEvent; return driver; },
    ...hostOptions
  });
  return { repos, runtime, driver, emit: (event: any) => emit(event) };
}

/** 宿主（插件 hook）接入点：permission.request 代为决定、任务结算通知。 */
describe('runtime host hooks', () => {
  it('applies host allow/deny without a pending approval and leaves undecided requests to people', async () => {
    const reviewPermission = vi.fn(async (_session, request: { title?: string }) => request.title === 'Read?' ? 'allow' as const : request.title === 'Delete?' ? 'deny' as const : undefined);
    const h = harness({ reviewPermission });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'p1', title: 'Read?', status: 'pending' } });
      h.emit({ type: 'permission_request', data: { id: 'p2', title: 'Delete?', status: 'pending' } });
      h.emit({ type: 'permission_request', data: { id: 'p3', title: 'Write?', status: 'pending' } });
      await gate;
      h.emit({ type: 'text', data: { text: 'done' } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(session.id, 'work');
    await vi.waitFor(() => expect(h.driver.resolvePermission).toHaveBeenCalledTimes(2));
    expect(h.driver.resolvePermission).toHaveBeenCalledWith('p1', true);
    expect(h.driver.resolvePermission).toHaveBeenCalledWith('p2', false);
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(session.id)).toHaveLength(1));
    expect((h.runtime.getPendingPermissions(session.id)[0] as { title?: string }).title).toBe('Write?');
    const statuses = (await h.runtime.getEvents(session.id)).filter(event => event.type === 'permission_request').map(event => [(event.data as any).title, (event.data as any).status]);
    expect(statuses).toEqual(expect.arrayContaining([['Read?', 'approved'], ['Delete?', 'rejected'], ['Write?', 'pending']]));
    expect(statuses.filter(([title]) => title !== 'Write?').every(([, status]) => status !== 'pending')).toBe(true);
    const writeId = h.runtime.getPendingPermissions(session.id)[0]!.id;
    expect((await h.runtime.resolvePermission(session.id, writeId, true)).status).toBe('approved');
    release();
    const settled = await turn;
    expect(settled.status).toBe('completed');
    await h.runtime.shutdown(); h.repos.close();
  });

  it('treats a throwing reviewer as undecided', async () => {
    const h = harness({ reviewPermission: async () => { throw new Error('hook crashed'); } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.driver.send = vi.fn(async () => {
      h.emit({ type: 'permission_request', data: { id: 'p1', title: 'Write?', status: 'pending' } });
      await gate;
      h.emit({ type: 'text', data: { text: 'done' } });
      h.emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const turn = h.runtime.send(session.id, 'work');
    await vi.waitFor(() => expect(h.runtime.getPendingPermissions(session.id)).toHaveLength(1));
    expect(h.driver.resolvePermission).not.toHaveBeenCalled();
    release();
    await turn;
    await h.runtime.shutdown(); h.repos.close();
  });

  it('notifies the host once per settled task without delaying the result', async () => {
    const onTaskSettled = vi.fn();
    const h = harness({ onTaskSettled });
    h.driver.send = vi.fn(async () => { h.emit({ type: 'text', data: { text: 'done' } }); h.emit({ type: 'completed', data: { stopReason: 'end_turn' } }); });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    const task = await h.runtime.send(session.id, 'work');
    expect(task.status).toBe('completed');
    await vi.waitFor(() => expect(onTaskSettled).toHaveBeenCalledTimes(1));
    expect(onTaskSettled).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }), expect.objectContaining({ id: task.id, status: 'completed' }));
    await h.runtime.shutdown(); h.repos.close();
  });
});
