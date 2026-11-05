import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, workPlanSchema, type AgentDriver, type WorkItem, type WorkPlan } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { WorkItemService, readWorkItemStatus, workItemProgressStatus, workPlanDigest } from './work-items.js';

const cleanup: Array<() => Promise<void>> = [];
it('does not read historical completed result blobs during idle ticks, including after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'work-history-index-')), path = join(directory, 'history.db');
  let repos = createRepositories(path);
  let service = new WorkItemService({ repositories: repos, runtime: {} as DutydeckRuntime, authorize: async () => true });
  try {
    for (let i = 0; i < 100; i++) await repos.config.set(`work_item:old-${i}`, JSON.stringify({ item: { id: `old-${i}`, status: 'completed', delivery: { status: 'delivered' }, output: { text: 'x'.repeat(16 * 1024) } } }));
    await service.close(); repos.close(); repos = createRepositories(path);
    service = new WorkItemService({ repositories: repos, runtime: {} as DutydeckRuntime, authorize: async () => true });
    const get = vi.spyOn(repos.config, 'get'), list = vi.spyOn(repos.config, 'list');
    await service.tick(); await service.tick();
    expect(get.mock.calls.filter(([key]) => key.startsWith('work_item:'))).toEqual([]);
    expect(list.mock.calls.filter(([prefix]) => prefix === 'work_item:')).toEqual([]);
  } finally { await service.close(); repos.close(); await rm(directory, { recursive: true, force: true }); }
});
it.each([[800, 1], [20, 0]])('the 1s tick taking %sms logs %s slow-loop warning(s)', async (tickMs, warnings) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const directory = await mkdtemp(join(tmpdir(), 'work-tick-timing-'));
  const repos = createRepositories(join(directory, 'timing.db'));
  const warn = vi.fn();
  const service = new WorkItemService({ repositories: repos, runtime: {} as DutydeckRuntime, authorize: async () => true, log: { warn } });
  try {
    vi.spyOn(repos.workItems, 'listScheduledIds').mockImplementation(() => { now += tickMs; return Promise.resolve([]); });
    service.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledTimes(warnings);
    if (warnings) expect(warn).toHaveBeenCalledWith(expect.objectContaining({ loop: 'work-items.tick', durationMs: tickMs }), expect.any(String));
  } finally { await service.close(); repos.close(); clock.mockRestore(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); }
});
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Condition did not converge');
}
const plan: WorkPlan = {
  title: 'Independent research',
  steps: [
    { id: 'a', title: 'First research', kind: 'agent', agentId: 'alpha', instruction: 'Research A', dependsOn: [] },
    { id: 'b', title: 'Second research', kind: 'agent', agentId: 'beta', instruction: 'Research B', dependsOn: [] },
    { id: 'join', title: 'Synthesis', kind: 'agent', agentId: 'alpha', instruction: 'Compare both results', dependsOn: ['a', 'b'] }
  ], outputStepId: 'join'
};
interface Call { sessionId: string; prompt: string; finish: (text: string | string[], failed?: boolean) => void }
async function fixture(stopProof: 'confirmed' | 'missing' | 'unproven' = 'confirmed', git = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-work-items-'));
  if (git) {
    const run = promisify(execFile);
    await run('git', ['init', directory]);
    await writeFile(join(directory, 'seed.txt'), 'baseline');
    await run('git', ['-C', directory, 'add', 'seed.txt']);
    await run('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
  }
  const repos = createRepositories(join(directory, 'test.db'), { newDatabaseAuthority: 'ledger_v1' });
  const agents = ['alpha', 'beta'].map(id => agentConfigSchema.parse({ id, name: id, command: 'fake', protocol: 'acp', cwd: directory, permissionMode: 'ask' }));
  const calls: Call[] = []; const stopped: string[] = [];
  let beforeSubmit: (() => Promise<void>) | undefined;
  let beforeStart: (() => Promise<void>) | undefined;
  const deniedAgents = new Set<string>();
  let promptPolicy: 'legacy-v1' | 'optimized-v1' = 'legacy-v1';
  let allowed = true; let gated = false; let service: WorkItemService; let runtime: DutydeckRuntime;
  const deliveries = vi.fn(async (_item: WorkItem) => {});
  const notifications = vi.fn(async (_item: WorkItem, _actorId: string) => {});
  const makeRuntime = () => new DutydeckRuntime(repos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    selectPromptPolicy: async () => ({ version: promptPolicy }),
    probe: (() => ({ available: true, protocol: 'acp', acp: true, jsonl: false, pipe: false, pty: false })) as any,
    authorizeExecution: async (id, actor) => { await service.authorizeExecution(id, actor); },
    authorizeControl: async (id, actor) => { await service.authorizeControl(id, actor); },
    sessionPrompt: async (session, prompt) => { if (session.source === 'work_item') await beforeSubmit?.(); return prompt; },
    authorizeTask: (session, task, phase) => service.authorizeTask(session, task, phase),
    driverFactory: (_agent, _protocol, onEvent, _onExit, sessionId) => {
      let current: (() => void) | undefined;
      // 真实驱动被 stop 杀死时，挂起中的 start() 必须随之结束；fixture 用 stop 信号竞速外部启动门禁。
      let killStartup: ((error: Error) => void) | undefined;
      const startupKilled = () => new Promise<void>((_resolve, reject) => { killStartup = reject; });
      return {
        start: async () => { if (sessionId.startsWith('ses_work_')) await Promise.race([beforeStart?.() ?? Promise.resolve(), startupKilled()]); }, resume: async () => {}, interrupt: async () => { current?.(); },
        stop: async () => { stopped.push(sessionId); killStartup?.(new Error('driver stopped during startup')); current?.(); },
        ...(stopProof === 'missing' ? {} : { isStopped: async () => stopProof === 'confirmed' && stopped.includes(sessionId) }),
        isIdle: () => !current, hasBackgroundWork: () => false,
        send: (prompt: string) => new Promise<void>(resolve => {
          current = () => { current = undefined; onEvent({ type: 'completed', data: { stopReason: 'cancelled' } }); resolve(); };
          calls.push({ sessionId, prompt, finish(text, failed) {
            if (failed) onEvent({ type: 'error', data: { message: 'Synthetic failure' } });
            if (Array.isArray(text)) {
              for (const [index, chunk] of text.entries()) {
                onEvent({ type: 'text', data: { text: chunk } });
                if (index < text.length - 1) {
                  onEvent({ type: 'tool_call', data: { id: `read-${index}`, name: 'read_file', status: 'running' } });
                  onEvent({ type: 'tool_result', data: { id: `read-${index}`, status: 'completed', output: 'file contents inspected' } });
                }
              }
            } else if (text) onEvent({ type: 'text', data: { text } });
            onEvent({ type: 'completed', data: { stopReason: 'end_turn' } }); current = undefined; resolve();
          } });
        })
      } satisfies AgentDriver;
    }
  });
  const makeService = () => new WorkItemService({ repositories: repos, runtime, authorize: async (_id, actor) => allowed && (actor === 'ou_owner' || actor === 'installation_owner'), authorizeAgent: async (_parent, _actor, id) => !deniedAgents.has(id), requireConfirmation: () => gated, deliver: deliveries, notify: notifications });
  runtime = makeRuntime(); service = makeService(); await runtime.initialize(agents);
  const parent = await runtime.start({ agentId: 'alpha', cwd: directory, source: 'lark', sourceId: 'cli_app:ou_owner:root_message', permissionMode: 'ask' });
  cleanup.push(async () => { await service.close(); await runtime.shutdown(); await repos.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    setPolicy(version: typeof promptPolicy) { promptPolicy = version; },
    repos, agents, parent, calls, stopped, deliveries, notifications,
    holdStart(action: () => Promise<void>) { beforeStart = action; },
    get service() { return service; }, get runtime() { return runtime; },
    deny() { allowed = false; }, allow() { allowed = true; }, denyAgent(id: string) { deniedAgents.add(id); }, holdSubmit(action: () => Promise<void>) { beforeSubmit = action; },
    gate(on = true) { gated = on; },
    async recreateService() { await service.close(); service = makeService(); },
    async reboot(holdQueue = false) { await service.close(); await runtime.shutdown(); runtime = makeRuntime(); runtime.setQueueHeld(holdQueue); service = makeService(); await runtime.initialize(agents); },
    create: (custom = plan, key = 'request-1') => service.create(parent.id, { goal: 'Compare evidence', plan: custom, idempotencyKey: key }, 'ou_owner'),
    get: (id: string) => service.get(parent.id, id, 'ou_owner'),
    async tick() { await service.tick(); await new Promise(resolve => setTimeout(resolve, 10)); },
    async finish(call: Call, text: string | string[], failed = false) {
      call.finish(text, failed);
      await eventually(async () => (await repos.tasks.listBySession(call.sessionId)).every(task => !['queued', 'running'].includes(task.status)));
    }
  };
}

describe('Work plan validation', () => {
  it('rejects cycles, disconnected steps, missing agents and foreign wait conditions', () => {
    expect(() => workPlanSchema.parse({ ...plan, steps: [{ ...plan.steps[0], dependsOn: ['a'] }], outputStepId: 'a' })).toThrow();
    expect(() => workPlanSchema.parse({ ...plan, outputStepId: 'a' })).toThrow();
    expect(() => workPlanSchema.parse({ ...plan, steps: [{ ...plan.steps[0], agentId: undefined }], outputStepId: 'a' })).toThrow();
    expect(() => workPlanSchema.parse({ ...plan, steps: plan.steps.map(step => step.id === 'join' ? { ...step, when: { stepId: 'a', equals: 'yes' } } : step) })).toThrow();
  });
});

async function otherParent(f: Awaited<ReturnType<typeof fixture>>, key: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-work-admission-'));
  cleanup.push(async () => { await rm(cwd, { recursive: true, force: true }); });
  return f.runtime.start({ agentId: 'alpha', cwd, source: 'lark', sourceId: `cli_app:ou_owner:${key}`, permissionMode: 'ask' });
}
const singlePlan: WorkPlan = { ...plan, steps: [plan.steps[0]!], outputStepId: 'a' };
const crowdedPlan: WorkPlan = { title: 'Crowded', steps: [
  ...['a', 'b', 'c'].map(id => ({ ...plan.steps[0]!, id })),
  { ...plan.steps[2]!, dependsOn: ['a', 'b', 'c'] }
], outputStepId: 'join' };

describe('Work-item queue admission and execution deadlines', () => {
  it('defers shared-workspace preparation and lets an independent directory start', async () => {
    const f = await fixture();
    const first = await f.create(crowdedPlan, 'crowded-one');
    const second = await f.create(crowdedPlan, 'crowded-two');
    await f.tick(); await eventually(async () => f.calls.length === 1);
    const crowded = [...(await f.get(first.id)).steps, ...(await f.get(second.id)).steps];
    expect(crowded.flatMap(step => step.attempts)).toHaveLength(1);
    expect(await f.repos.workItems.countActiveSteps()).toBe(1);
    const parent = await otherParent(f, 'independent');
    const item = await f.service.create(parent.id, { goal: 'Independent', plan: singlePlan, idempotencyKey: 'independent' }, 'ou_owner');
    await f.tick(); await eventually(async () => f.calls.length === 2);
    const child = (await f.service.get(parent.id, item.id, 'ou_owner')).steps[0]!.attempts[0]!;
    expect(f.calls.filter(call => call.sessionId === child.sessionId)).toHaveLength(1);
    expect(await f.repos.workItems.countActiveSteps()).toBe(2);
  });

  it('admits an independent directory beside six previously accepted queues after restart', async () => {
    const f = await fixture(); f.runtime.setQueueHeld(true);
    const preflight = vi.spyOn(f.runtime, 'canPrepareWorkItemWorkspace').mockReturnValue(true);
    const one = await f.create(crowdedPlan, 'old-one'); await f.create(crowdedPlan, 'old-two');
    await f.tick(); expect(await f.repos.workItems.countActiveSteps()).toBe(6);
    expect(f.calls).toHaveLength(0); preflight.mockRestore();
    await f.reboot(true);
    const parent = await otherParent(f, 'independent-old-queue');
    const item = await f.service.create(parent.id, { goal: 'Independent', plan: singlePlan, idempotencyKey: 'independent-old-queue' }, 'ou_owner');
    await f.tick(); expect(await f.repos.workItems.countActiveSteps()).toBe(7);
    expect((await f.get(one.id)).steps.slice(0, 3).every(step => f.repos.execution.getTaskExecution(step.attempts[0]!.taskId!)?.task.status === 'queued')).toBe(true);
    f.runtime.setQueueHeld(false); await eventually(async () => f.calls.length === 2);
    const child = (await f.service.get(parent.id, item.id, 'ou_owner')).steps[0]!.attempts[0]!;
    expect(f.calls.filter(call => call.sessionId === child.sessionId)).toHaveLength(1);
    const running = await Promise.all(f.calls.map(call => f.repos.sessions.get(call.sessionId)));
    expect(running.filter(session => session!.cwd === f.directory)).toHaveLength(1);
  });

  it('keeps 61-minute-old accepted sources runnable and submits each once after restart', async () => {
    const f = await fixture(); f.runtime.setQueueHeld(true);
    vi.spyOn(f.runtime, 'canPrepareWorkItemWorkspace').mockReturnValue(true);
    const item = await f.create(); await f.tick();
    const record = JSON.parse((await f.repos.config.get('work_item:' + item.id))!);
    const createdAt = new Date(Date.now() - 61 * 60_000).toISOString();
    for (const step of record.item.steps.slice(0, 2)) step.attempts[0].createdAt = createdAt;
    await f.repos.config.set('work_item:' + item.id, JSON.stringify(record));
    const db = new Database(join(f.directory, 'test.db'));
    try { for (const step of record.item.steps.slice(0, 2)) db.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(createdAt, step.attempts[0].taskId); }
    finally { db.close(); }
    await f.reboot(true); await f.tick();
    for (const step of record.item.steps.slice(0, 2)) expect(await f.service.authorizeExecution(step.attempts[0].sessionId, 'ou_owner')).toBe(true);
    f.runtime.setQueueHeld(false); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'First result'); await eventually(async () => f.calls.length === 2);
    await f.finish(f.calls[1]!, 'Second result'); await f.tick(); await eventually(async () => f.calls.length === 3);
    for (const step of (await f.get(item.id)).steps.slice(0, 2)) {
      const source = step.attempts[0]!;
      const projection = f.repos.execution.getTaskExecution(source.taskId!)!;
      expect(source.createdAt).toBe(createdAt); expect(projection.attempts).toHaveLength(1);
      expect(projection.task.createdAt).toBe(createdAt);
      expect(Date.parse(projection.attempts[0]!.createdAt)).toBeGreaterThan(Date.parse(createdAt) + 60 * 60_000);
      expect(f.calls.filter(call => call.sessionId === source.sessionId)).toHaveLength(1);
    }
  });

  it('still expires actual execution one hour after the first Runtime attempt starts', async () => {
    const f = await fixture(); const item = await f.create(singlePlan); await f.tick(); await eventually(async () => f.calls.length === 1);
    const source = (await f.get(item.id)).steps[0]!.attempts[0]!;
    const startedAt = f.repos.execution.getTaskExecution(source.taskId!)!.attempts[0]!.createdAt;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse(startedAt) + 60 * 60_000);
      await expect(f.service.authorizeExecution(source.sessionId!, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_TASK_REVOKED' });
      await f.service.tick();
      expect((await f.get(item.id)).steps[0]).toMatchObject({ status: 'blocked', attempts: [expect.objectContaining({ error: expect.stringContaining('one-hour limit') })] });
      expect(f.stopped).toContain(source.sessionId);
      f.calls[0]!.finish('Late result'); await f.service.tick();
      expect((await f.get(item.id)).output).toBeUndefined(); expect(f.calls).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('bounds prepared queues at twelve and concurrent wakeups at six actual executions', async () => {
    const f = await fixture(); f.runtime.setQueueHeld(true);
    for (let i = 0; i < 14; i++) {
      const parent = await otherParent(f, 'capacity-' + i);
      await f.service.create(parent.id, { goal: 'Independent', plan: singlePlan, idempotencyKey: 'capacity-' + i }, 'ou_owner');
    }
    await f.tick(); expect(await f.repos.workItems.countActiveSteps()).toBe(12);
    expect((await f.runtime.listSessions()).filter(session => session.source === 'work_item')).toHaveLength(12);
    expect(f.calls).toHaveLength(0);
    f.runtime.setQueueHeld(false); await vi.waitFor(() => expect(f.calls).toHaveLength(6), { timeout: 10_000 });
    await f.tick(); expect(f.calls).toHaveLength(6);
    await f.finish(f.calls[0]!, 'Permit released'); await vi.waitFor(() => expect(f.calls).toHaveLength(7), { timeout: 10_000 });
    await f.tick(); expect(f.calls).toHaveLength(7);
    const tasks = (await Promise.all((await f.runtime.listSessions()).filter(session => session.source === 'work_item').map(session => f.repos.tasks.listBySession(session.id)))).flat();
    expect(tasks.filter(task => task.status === 'running')).toHaveLength(6);
  }, 20_000);

  it.each(['cancel', 'revoke'] as const)('rechecks authority for an old accepted queue after %s', async action => {
    const f = await fixture(); f.runtime.setQueueHeld(true);
    const item = await f.create(singlePlan); await f.tick(); const source = (await f.get(item.id)).steps[0]!.attempts[0]!;
    if (action === 'cancel') await f.service.cancel(f.parent.id, item.id, (await f.get(item.id)).revision, 'ou_owner'); else f.deny();
    f.runtime.setQueueHeld(false);
    await eventually(async () => f.repos.execution.getTaskExecution(source.taskId!)!.task.status === 'cancelled');
    expect(f.calls).toHaveLength(0); expect(f.repos.execution.getTaskExecution(source.taskId!)!.attempts.every(attempt => attempt.submissionState === 'not_submitted')).toBe(true);
    f.allow();
  });
});

describe('WorkItemService with real Runtime and SQLite', () => {
  it('inherits the completed root task policy for child tasks after an installation policy change', async () => {
    const f = await fixture();
    f.setPolicy('optimized-v1');
    const root = await f.runtime.dispatch(f.parent.id, 'parent request', 'queue', 'parent request', undefined, 'ou_owner');
    await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'parent result');
    f.setPolicy('legacy-v1');
    const single = { ...plan, steps: [plan.steps[0]!], outputStepId: 'a' };
    const item = await f.service.create(f.parent.id, { goal: 'Compare evidence', plan: single, idempotencyKey: 'root-policy' }, 'ou_owner', undefined, root.id);
    await f.tick(); await eventually(async () => f.calls.length === 2);
    const child = f.calls[1]!;
    expect(child.prompt).toContain('Return completion status, complete artifacts');
    const task = (await f.repos.tasks.listBySession(child.sessionId))[0]!;
    expect(f.repos.execution.getAcceptedTask(task.id)?.input?.executionContext.promptPolicyVersion).toBe('optimized-v1');
    await f.finish(child, 'full artifact'); await f.tick();
    expect((await f.get(item.id)).status).toBe('completed');
  });
  it('serializes branches sharing a workspace and synthesizes full frozen results exactly once', async () => {
    const f = await fixture();
    // Simulate a preflight race or an already accepted queue; ledger checks must still hold.
    vi.spyOn(f.runtime, 'canPrepareWorkItemWorkspace').mockReturnValue(true); const item = await f.create();
    await f.tick(); await eventually(async () => f.calls.length === 1);
    const admitted = (await f.get(item.id)).steps.slice(0, 2).map(step => step.attempts[0]!);
    expect(new Set(admitted.map(attempt => attempt.sessionId)).size).toBe(2);
    expect((await Promise.all(admitted.map(attempt => f.repos.tasks.listBySession(attempt.sessionId!)))).flat().map(task => task.status).sort()).toEqual(['queued', 'running']);
    for (const attempt of admitted) expect(await f.service.parentForSession(attempt.sessionId!)).toMatchObject({ parentSessionId: f.parent.id, actorId: 'ou_owner', workId: item.id });
    await f.finish(f.calls[0]!, 'First result');
    await eventually(async () => f.calls.length === 2);
    await f.finish(f.calls[1]!, 'Second result');
    await f.tick(); await eventually(async () => f.calls.length === 3);
    expect(f.calls[2]!.prompt).toContain('First result'); expect(f.calls[2]!.prompt).toContain('Second result');
    await f.finish(f.calls[2]!, 'Complete comparison'); await f.tick();
    const done = await f.get(item.id);
    expect(done.status).toBe('completed'); expect(done.output).toMatchObject({ text: 'Complete comparison', digest: expect.stringMatching(/^[a-f0-9]{64}$/), stepId: 'join' });
    expect(done.delivery.status).toBe('delivered');
    await f.tick(); expect(f.deliveries).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(done)).not.toContain('ou_owner');
  });

  it('runs work items in different Git repositories concurrently', async () => {
    const f = await fixture('confirmed', true);
    const otherCwd = await mkdtemp(join(tmpdir(), 'dutydeck-work-other-repo-'));
    cleanup.push(async () => { await rm(otherCwd, { recursive: true, force: true }); });
    const run = promisify(execFile);
    await run('git', ['init', otherCwd]);
    await writeFile(join(otherCwd, 'seed.txt'), 'other repository');
    await run('git', ['-C', otherCwd, 'add', 'seed.txt']);
    await run('git', ['-C', otherCwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
    const otherParent = await f.runtime.start({ agentId: 'alpha', cwd: otherCwd, source: 'lark', sourceId: 'cli_app:ou_owner:other_root', permissionMode: 'ask' });
    const single = { ...plan, steps: [plan.steps[0]!], outputStepId: 'a' };
    const first = await f.create(single);
    const second = await f.service.create(otherParent.id, { goal: 'Other repository', plan: single, idempotencyKey: 'other-work' }, 'ou_owner');
    await f.tick(); await eventually(async () => f.calls.length === 2);
    const tasks = (await Promise.all(f.calls.map(call => f.repos.tasks.listBySession(call.sessionId)))).flat();
    expect(tasks.map(task => task.status)).toEqual(['running', 'running']);
    expect(new Set((await Promise.all(f.calls.map(call => f.repos.sessions.get(call.sessionId)))).map(session => session!.cwd))).toEqual(new Set([f.directory, otherCwd]));
    await f.finish(f.calls[0]!, 'First repository complete'); await f.finish(f.calls[1]!, 'Other repository complete');
    await f.tick();
    expect((await f.get(first.id)).status).toBe('completed');
    expect((await f.service.get(otherParent.id, second.id, 'ou_owner')).status).toBe('completed');
    expect(f.deliveries).toHaveBeenCalledTimes(2);
  });

  it('holds a gated plan until a human confirms and dispatches nothing before that, across a restart', async () => {
    const f = await fixture(); f.gate();
    const item = await f.create();
    expect(item.status).toBe('awaiting_confirmation');
    for (let round = 0; round < 3; round++) await f.tick();
    expect(f.calls).toHaveLength(0);
    expect((await f.runtime.listSessions()).filter(session => session.source === 'work_item')).toHaveLength(0);
    expect((await f.get(item.id)).steps.every(step => step.status === 'pending' && !step.attempts.length)).toBe(true);
    await f.reboot(); await f.tick();
    expect((await f.get(item.id)).status).toBe('awaiting_confirmation');
    expect(f.calls).toHaveLength(0);
    const pending = await f.get(item.id);
    await expect(f.service.confirm(f.parent.id, item.id, pending.revision, 'ou_other')).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.service.confirm(f.parent.id, item.id, pending.revision + 5, 'ou_owner')).rejects.toMatchObject({ statusCode: 409 });
    await f.tick(); expect(f.calls).toHaveLength(0);
    expect((await f.service.confirm(f.parent.id, item.id, pending.revision, 'ou_owner')).status).toBe('running');
    await expect(f.service.confirm(f.parent.id, item.id, pending.revision + 1, 'ou_owner')).rejects.toMatchObject({ statusCode: 409 });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    expect((await f.get(item.id)).steps.slice(0, 2).map(step => [step.status, step.attempts.length])).toEqual([['running', 1], ['pending', 0]]);
  });

  it('refuses to turn an unconfirmed plan into a reusable template', async () => {
    const f = await fixture(); f.gate();
    const item = await f.create();
    await expect(f.service.saveTemplate(f.parent.id, item.id, '未确认流程', 'ou_owner')).rejects.toMatchObject({ code: 'WORK_TEMPLATE_UNCONFIRMED' });
    await f.service.confirm(f.parent.id, item.id, item.revision, 'ou_owner');
    expect((await f.service.saveTemplate(f.parent.id, item.id, '已确认流程', 'ou_owner')).version).toBe(1);
  });

  it('cancels a gated plan without ever starting a step', async () => {
    const f = await fixture(); f.gate();
    const item = await f.create();
    await f.service.cancel(f.parent.id, item.id, item.revision, 'ou_owner');
    expect((await f.get(item.id)).status).toBe('cancelled');
    await f.tick(); expect(f.calls).toHaveLength(0);
    await expect(f.service.confirm(f.parent.id, item.id, (await f.get(item.id)).revision, 'ou_owner')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('recovers a lost accepted response without sending a second prompt', async () => {
    const f = await fixture(); const dispatch = f.runtime.dispatchRequest.bind(f.runtime);
    vi.spyOn(f.runtime, 'dispatchRequest').mockImplementationOnce(async (...args) => { await dispatch(...args); throw new Error('response lost'); });
    const single = { ...plan, steps: [plan.steps[0]!], outputStepId: 'a' };
    const item = await f.create(single); await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.recreateService(); await f.tick(); expect(f.calls).toHaveLength(1);
    await f.finish(f.calls[0]!, 'Recovered result'); await f.tick();
    expect((await f.get(item.id)).status).toBe('completed');
    expect((await f.repos.tasks.listBySession(f.calls[0]!.sessionId))).toHaveLength(1);
  });

  it('persists cancellation, stops only owned children and rejects late success and joins', async () => {
    const f = await fixture();
    // Simulate a preflight race or an already accepted queue; ledger checks must still hold.
    vi.spyOn(f.runtime, 'canPrepareWorkItemWorkspace').mockReturnValue(true); const item = await f.create(); const unrelated = await f.runtime.start({ agentId: 'alpha', cwd: f.parent.cwd });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    const current = await f.get(item.id);
    await f.service.cancel(f.parent.id, item.id, current.revision, 'ou_owner');
    expect((await f.get(item.id)).status).toBe('cancelled');
    for (const step of current.steps.slice(0, 2)) {
      expect(f.stopped).toContain(step.attempts[0]!.sessionId);
      const execution = f.repos.execution.getSessionExecutions(step.attempts[0]!.sessionId!)[0]!;
      expect(execution.task.status).toBe(step.attempts[0]!.sessionId === f.calls[0]!.sessionId ? 'reconcile_required' : 'cancelled');
      if (execution.currentAttempt) expect(execution.currentAttempt.reconcileReason?.code).toBe('STOP_RESULT_UNKNOWN');
    }
    expect(f.stopped).not.toContain(unrelated.id);
    f.calls[0]!.finish('Late result'); await f.tick();
    expect((await f.get(item.id)).output).toBeUndefined(); expect(f.calls).toHaveLength(1); expect(f.deliveries).not.toHaveBeenCalled();
    await f.reboot(); await f.tick(); expect((await f.get(item.id)).status).toBe('cancelled'); expect(f.calls).toHaveLength(1);
  });

  it('keeps waits durable and rejects unauthorized, stale and duplicate answers', async () => {
    const f = await fixture();
    const waitPlan: WorkPlan = { title: 'Decision', steps: [
      { id: 'approval', title: 'Choose', kind: 'wait', instruction: 'Choose yes or no', dependsOn: [] },
      { ...plan.steps[0]!, dependsOn: ['approval'], when: { stepId: 'approval', equals: 'yes' } },
      { ...plan.steps[1]!, dependsOn: ['approval'], when: { stepId: 'approval', equals: 'no' } },
      plan.steps[2]!
    ], outputStepId: 'join' };
    const item = await f.create(waitPlan); await f.tick(); expect((await f.get(item.id)).status).toBe('waiting');
    await f.reboot(); await f.tick(); const waiting = await f.get(item.id);
    await expect(f.service.answer(f.parent.id, item.id, 'approval', 'yes', waiting.revision, 'ou_other')).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.service.answer(f.parent.id, item.id, 'approval', 'yes', 1, 'ou_owner')).rejects.toMatchObject({ statusCode: 409 });
    await f.service.answer(f.parent.id, item.id, 'approval', 'yes', waiting.revision, 'ou_owner');
    await expect(f.service.answer(f.parent.id, item.id, 'approval', 'yes', waiting.revision, 'ou_owner')).rejects.toMatchObject({ statusCode: 409 });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    expect((await f.get(item.id)).steps.find(step => step.id === 'b')?.status).toBe('skipped');
    await f.finish(f.calls[0]!, 'Approved research'); await f.tick(); await eventually(async () => f.calls.length === 2);
    expect(f.calls[1]!.prompt).toContain('Approved research');
  });

  it('denies a foreign actor or App when stopping an owned child after execution revocation', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick();
    await eventually(async () => f.calls.length === 1);
    const child = f.calls[0]!.sessionId;
    await expect(f.runtime.stopWorkItemSession(child, { kind: 'channel', id: 'ou_other', appId: 'cli_app' })).rejects.toMatchObject({ code: 'WORK_ITEM_FORBIDDEN' });
    await expect(f.runtime.stopWorkItemSession(child, { kind: 'channel', id: 'ou_owner', appId: 'other_app' })).rejects.toMatchObject({ code: 'TASK_ACTOR_CONFLICT' });
    expect(f.stopped).not.toContain(child);
    f.deny(); await f.tick();
    expect(f.stopped).toContain(child);
    await expect(f.service.authorizeExecution(child, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_TASK_REVOKED' });
    expect((await f.get(item.id).catch(() => undefined))).toBeUndefined();
  });

  it('only retries the failed branch and preserves succeeded siblings', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'Kept result'); await f.tick(); await eventually(async () => f.calls.length === 2); await f.finish(f.calls[1]!, '', true); await f.tick();
    const failed = await f.get(item.id); expect(failed.status).toBe('failed');
    await f.service.retryStep(f.parent.id, item.id, 'b', failed.revision, 'ou_owner'); await f.tick();
    await eventually(async () => f.calls.length === 3);
    expect(f.calls[2]!.prompt).toContain('Research B'); expect((await f.get(item.id)).steps[0]!.attempts).toHaveLength(1);
    await f.finish(f.calls[2]!, 'New result'); await f.tick(); await eventually(async () => f.calls.length === 4);
    expect(f.calls[3]!.prompt).toContain('Kept result'); expect(f.calls[3]!.prompt).toContain('New result');
  });

  it('stops each child once its result is saved and retries in a fresh child', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'Kept result'); await f.tick(); await eventually(async () => f.calls.length === 2);
    const [kept, failed] = f.calls.map(call => call.sessionId);
    await f.finish(f.calls[1]!, '', true); await f.tick();
    const { revision } = await f.get(item.id);
    // 停止在 tick 之外进行且不写记录：卡片刚拿到的版本号仍然有效，可以立刻重试。
    await eventually(async () => [kept, failed].every(id => f.stopped.includes(id)));
    expect(f.stopped).not.toContain(f.parent.id);
    expect((await f.get(item.id)).revision).toBe(revision);
    await f.service.retryStep(f.parent.id, item.id, 'b', revision, 'ou_owner'); await f.tick();
    await eventually(async () => f.calls.length === 3);
    // 重试起的是新子会话，运行中不能被回收。
    await f.tick(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.stopped).not.toContain(f.calls[2]!.sessionId);
    await f.finish(f.calls[2]!, 'New result'); await f.tick(); await eventually(async () => f.calls.length === 4);
    await f.finish(f.calls[3]!, 'Complete comparison'); await f.tick();
    expect((await f.get(item.id)).status).toBe('completed');
    await eventually(async () => [f.calls[2]!.sessionId, f.calls[3]!.sessionId].every(id => f.stopped.includes(id)));
  });

  it('blocks configuration drift and never falls back to a global owner', async () => {
    const f = await fixture(); const item = await f.create();
    await f.repos.agents.save({ ...f.agents[0]!, model: 'changed' }); await f.tick();
    expect((await f.get(item.id)).status).toBe('blocked'); expect(f.calls).toHaveLength(0);
    await expect(f.service.create(f.parent.id, { goal: 'x', plan, idempotencyKey: 'anonymous' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.service.get(f.parent.id, item.id, 'ou_other')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects blocked configuration drift locally, retries the authorized stop, and rechecks live access after repair', async () => {
    const f = await fixture('unproven');
    const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.repos.agents.save({ ...f.agents[0]!, model: 'changed' });
    await f.tick();
    const saved = () => f.repos.config.get(`work_item:${item.id}`).then(raw => JSON.parse(raw!));
    expect((await saved()).item).toMatchObject({ status: 'blocked', steps: [{ status: 'blocked' }] });
    const blocked = await saved();
    const authorize = vi.spyOn((f.service as any).options, 'authorize').mockResolvedValue(false);
    const stop = vi.spyOn(f.runtime, 'stopWorkItemSession');
    try {
      const notices = f.notifications.mock.calls.length;
      f.notifications.mockRejectedValueOnce(new Error('temporary delivery failure'));
      await f.service.tick(); await f.service.tick();
      expect(authorize).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledWith(f.calls[0]!.sessionId, { kind: 'channel', appId: 'cli_app', id: 'ou_owner' });
      expect(await saved()).toEqual(blocked);
      expect(f.notifications).toHaveBeenCalledTimes(notices + 2);
      expect(f.calls).toHaveLength(1);
      stop.mockResolvedValueOnce(true);
      await f.service.tick();
      expect((await saved()).stoppedAttempts).toContain(blocked.item.steps[0].attempts[0].id);
      expect((await saved()).item.revision).toBe(blocked.item.revision + 1);
      await f.repos.agents.save(f.agents[0]!);
      await f.service.tick();
      expect(authorize).toHaveBeenCalled();
      expect((await saved()).item).toMatchObject({ status: 'blocked', error: 'Work-item access denied' });
      expect(f.calls).toHaveLength(1);
    } finally { authorize.mockRestore(); stop.mockRestore(); }
  });

  it('keeps immutable template versions and detects conflicting request keys', async () => {
    const f = await fixture(); const item = await f.create();
    expect((await f.create()).id).toBe(item.id);
    await expect(f.service.create(f.parent.id, { goal: 'Changed goal', plan, idempotencyKey: 'request-1' }, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_IDEMPOTENCY_CONFLICT' });
    const v1 = await f.service.saveTemplate(f.parent.id, item.id, 'Research', 'ou_owner');
    const v2 = await f.service.saveTemplate(f.parent.id, item.id, 'Research', 'ou_owner');
    expect(v2.version).toBe(2);
    const run = await f.service.runTemplate(f.parent.id, v1.id, 1, 'New subject', 'template-run', 'ou_owner');
    expect(run.plan).toEqual(item.plan); expect(run.goal).toBe('New subject');
    expect(await f.service.listTemplates(f.parent.id, 'ou_owner')).toHaveLength(2);
  });

  it('does not attribute a detached template run (schedule or trigger) to the parent session\'s running turn', async () => {
    const f = await fixture(); const item = await f.create();
    const template = await f.service.saveTemplate(f.parent.id, item.id, 'Research', 'ou_owner');
    const riskPolicy = { enabled: true, authorized: false, pattern: 'rm -rf', reason: 'parent turn policy' };
    await f.runtime.dispatch(f.parent.id, 'parent turn', 'queue', undefined, riskPolicy, 'ou_owner');
    await eventually(async () => Boolean(f.runtime.getActiveTaskContext(f.parent.id)) && f.calls.some(call => call.sessionId === f.parent.id));
    const turn = f.runtime.getActiveTaskContext(f.parent.id)!.taskId;
    const stored = async (id: string) => JSON.parse((await f.repos.config.get(`work_item:${id}`))!);
    // 对照：交互入口（人或本轮 Agent）启动模板时归属当前这一轮，沿用它的风险策略。
    const inline = await f.service.runTemplate(f.parent.id, template.id, 1, 'Inline subject', 'template-inline', 'ou_owner');
    expect(await stored(inline.id)).toMatchObject({ parentTaskId: turn, riskPolicy });
    const detached = await f.service.runTemplate(f.parent.id, template.id, 1, 'Scheduled subject', 'template-detached', 'ou_owner', undefined, true);
    const record = await stored(detached.id);
    expect(record.parentTaskId).toBeUndefined();
    expect(record.riskPolicy).toBeUndefined();
  });

  it('does not automatically replay an interrupted accepted attempt after restart', async () => {
    const f = await fixture(); const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' });
    await f.tick(); await eventually(async () => f.calls.length === 1); await f.reboot(); await f.tick();
    const blocked = await f.get(item.id); expect(blocked.status).toBe('blocked'); expect(f.calls).toHaveLength(1);
    await expect(f.service.retryStep(f.parent.id, item.id, 'a', blocked.revision, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_RETRY_UNSAFE' });
  });

  it('retries only delivery after a notification failure', async () => {
    const f = await fixture(); f.deliveries.mockRejectedValueOnce(new Error('delivery unavailable'));
    const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }); await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'Ready'); await f.tick(); expect((await f.get(item.id)).delivery.status).toBe('error');
    expect(await f.repos.workItems.listScheduledIds()).toContain(item.id);
    await f.recreateService();
    await f.tick(); expect((await f.get(item.id)).delivery.status).toBe('delivered'); expect(f.calls).toHaveLength(1); expect(f.deliveries).toHaveBeenCalledTimes(2);
    expect(await f.repos.workItems.listScheduledIds()).not.toContain(item.id);
    await f.tick(); expect(f.deliveries).toHaveBeenCalledTimes(2);
  });
  it('preserves invalid historical JSON without preventing another work item from advancing', async () => {
    const f = await fixture();
    const corrupt = ['{invalid', ...[null, true, 1, 'bad', [], [1], {}, { item: null }, { item: 'bad' }, { item: 1 }, { item: true }, { item: [] }, { item: [1] }, { item: {} }].map(value => JSON.stringify(value))];
    for (const [index, raw] of corrupt.entries()) await f.repos.config.set(`work_item:000-corrupt-${index}`, raw);
    const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    for (const [index, raw] of corrupt.entries()) expect(await f.repos.config.get(`work_item:000-corrupt-${index}`)).toBe(raw);
    await f.finish(f.calls[0]!, 'Ready'); await f.tick();
    expect((await f.get(item.id)).status).toBe('completed');
  });
  it('continues other work when recording a failed work item also fails', async () => {
    const f = await fixture();
    const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' });
    const broken = JSON.parse((await f.repos.config.get('work_item:' + item.id))!);
    broken.item.id = '000-repair'; broken.item.parentSessionId = 'missing-parent';
    const raw = JSON.stringify(broken), key = 'work_item:000-repair';
    await f.repos.config.set(key, raw);
    const original = f.repos.config.compareAndSet!.bind(f.repos.config);
    const cas = vi.spyOn(f.repos.config, 'compareAndSet').mockImplementation(async (target, expected, value) => {
      if (target === key) throw new Error('injected repair write failure');
      return original(target, expected, value);
    });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    expect(cas).toHaveBeenCalledWith(key, raw, expect.any(String));
    expect(await f.repos.config.get(key)).toBe(raw);
    await f.finish(f.calls[0]!, 'Ready'); await f.tick();
    expect((await f.get(item.id)).status).toBe('completed');
  });
  it('fences an accepted task before driver.send when cancellation wins preparation', async () => {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let enteredResolve!: () => void;
    const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
    f.holdSubmit(async () => { enteredResolve(); await gate; });
    try {
      const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }); await f.tick();
      await entered;
      const current = await f.get(item.id); const attempt = current.steps[0]!.attempts[0]!;
      expect(f.calls).toHaveLength(0);
      const cancelling = f.service.cancel(f.parent.id, item.id, current.revision, 'ou_owner');
      await eventually(async () => (await f.repos.tasks.listBySession(attempt.sessionId!))[0]?.status === 'cancelled');
      release();
      await cancelling; await f.tick();
      expect(f.calls).toHaveLength(0); expect((await f.get(item.id)).status).toBe('cancelled');
      expect((await f.repos.tasks.listBySession(attempt.sessionId!))[0]?.status).toBe('cancelled');
    } finally {
      release?.();
    }
  });

  it('serializes a live permission decision and a cancellation intent', async () => {
    const f = await fixture(); const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }); await f.tick(); await eventually(async () => f.calls.length === 1);
    let entered = false; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const decision = f.service.withActiveStep(f.parent.id, item.id, 'a', 'ou_owner', async () => { entered = true; await gate; return 'approved'; });
    await eventually(async () => entered); const current = await f.get(item.id);
    const cancel = f.service.cancel(f.parent.id, item.id, current.revision, 'ou_owner');
    await new Promise(resolve => setTimeout(resolve, 10)); expect((await f.get(item.id)).status).toBe('running');
    release(); expect(await decision).toBe('approved'); await cancel;
    await expect(f.service.withActiveStep(f.parent.id, item.id, 'a', 'ou_owner', async () => 'late')).rejects.toMatchObject({ code: 'WORK_ITEM_TASK_REVOKED' });
  });

  it('enforces agent-selection authority at creation and execution', async () => {
    const f = await fixture(); f.denyAgent('beta');
    await expect(f.create()).rejects.toMatchObject({ code: 'WORK_ITEM_AGENT_FORBIDDEN' });
    const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }); f.denyAgent('alpha'); await f.tick();
    expect((await f.get(item.id)).status).toBe('blocked'); expect(f.calls).toHaveLength(0);
  });

  it('rejects oversized generated output without truncating or advancing the join', async () => {
    const f = await fixture(); const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }); await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'x'.repeat(512 * 1024 + 1)); await f.tick();
    // 新账本契约：超限是明确结果读取错误，持久 blocked，不允许转 failed 后重试，也不截断交付。
    const blocked = await f.get(item.id); expect(blocked.status).toBe('blocked'); expect(blocked.output).toBeUndefined();
    expect(blocked.steps[0]!.attempts[0]!.blockReason).toBe('reconcile_required');
    expect(blocked.steps[0]!.attempts[0]!.error).toContain('exceeds'); expect(f.deliveries).not.toHaveBeenCalled();
    await expect(f.service.retryStep(f.parent.id, item.id, 'a', blocked.revision, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_RETRY_UNSAFE' });
  });

  it('guards parent identity against direct writes and blocks on configuration drift or stopped parents', async () => {
    const f = await fixture(); const item = await f.create();
    // 1. 父 Session 身份字段受仓储保护，旧直接写口必须抛 EXECUTION_LEDGER_REQUIRED 拒绝非法篡改
    const parentSession = (await f.repos.sessions.get(f.parent.id))!;
    await expect(f.repos.sessions.save({ ...parentSession, sourceId: 'different-group' })).rejects.toMatchObject({ code: 'EXECUTION_LEDGER_REQUIRED' });
    // 2. 通过合法配置变化（如 model）制造指纹漂移，验证来源检测到配置漂移后持久 blocked
    await f.repos.sessions.save({ ...parentSession, model: 'drifted-model' }); await f.tick();
    expect((await f.get(item.id)).status).toBe('blocked');
    await f.runtime.stop(f.parent.id);
    await expect(f.create(plan, 'stopped')).rejects.toMatchObject({ code: 'WORK_ITEM_PARENT_INACTIVE' });
    expect((await f.get(item.id)).id).toBe(item.id);
  });

  it('caps a work at three prepared branches and requires a trusted stable-session entry', async () => {
    const f = await fixture();
    // Simulate a preflight race or an already accepted queue; ledger checks must still hold.
    vi.spyOn(f.runtime, 'canPrepareWorkItemWorkspace').mockReturnValue(true);
    const branches = ['a', 'b', 'c', 'd'].map(id => ({ ...plan.steps[0]!, id }));
    const item = await f.create({ title: 'Bounded', steps: [...branches, { ...plan.steps[2]!, dependsOn: branches.map(step => step.id) }], outputStepId: 'join' });
    await f.tick(); await eventually(async () => f.calls.length === 1); await f.tick(); expect(f.calls).toHaveLength(1);
    expect((await f.get(item.id)).steps.filter(step => step.status === 'running')).toHaveLength(3);
    expect((await f.get(item.id)).steps.find(step => step.id === 'd')?.attempts).toHaveLength(0);
    await f.finish(f.calls[0]!, 'Done'); await f.tick(); await eventually(async () => f.calls.length === 2);
    expect((await f.get(item.id)).steps.find(step => step.id === 'd')?.attempts).toHaveLength(1);
    expect((await f.get(item.id)).steps.filter(step => step.status === 'running')).toHaveLength(3);
    await expect(f.runtime.start({ agentId: 'alpha', source: 'work_item', sourceId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_WORK_SESSION' });
  });

  it.each(['stop', 'archive', 'revoke'] as const)('stops active children when parent authority becomes %s', async mode => {
    const f = await fixture(); vi.spyOn(f.runtime, 'canPrepareWorkItemWorkspace').mockReturnValue(true); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 1);
    if (mode === 'stop') await f.runtime.stop(f.parent.id); else if (mode === 'archive') await f.runtime.archive(f.parent.id); else f.deny();
    await f.tick(); f.allow();
    const blocked = await f.get(item.id); expect(blocked.status).toBe('blocked');
    for (const call of f.calls) expect(f.stopped).toContain(call.sessionId);
    expect(blocked.steps.filter(step => step.status === 'blocked')).toHaveLength(2);
    expect(f.deliveries).not.toHaveBeenCalled();
  });

  it('times out startup and fences a late driver start without blocking other work', async () => {
    const f = await fixture(); let entered = false; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.holdStart(async () => { entered = true; await gate; });
    const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' });
    const realSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const tick = f.service.tick();
      for (let i = 0; i < 100 && !entered; i++) await new Promise(resolve => realSetTimeout(resolve, 5));
      expect(entered).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000); await tick;
      expect((await f.get(item.id)).status).toBe('blocked');
      release();
    } finally { vi.useRealTimers(); release(); }
    // 启动被限时停止栅栏：子 Session 必为终态（failed 或 stopped），迟到 start 不能复活执行。
    await eventually(async () => ['failed', 'stopped'].includes((await f.repos.sessions.get((await f.get(item.id)).steps[0]!.attempts[0]!.sessionId!))?.state ?? ''));
    expect(f.calls).toHaveLength(0); expect(f.deliveries).not.toHaveBeenCalled();
    await expect(f.service.retryStep(f.parent.id, item.id, 'a', (await f.get(item.id)).revision, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_RETRY_UNSAFE' });
    f.holdStart(async () => {});
    await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }, 'after-timeout'); await f.tick();
    await eventually(async () => f.calls.length === 1);
  });

  it.each(['missing', 'unproven'] as const)('keeps cancellation blocked when the driver stop proof is %s', async proof => {
    const f = await fixture(proof); const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    f.deny(); await f.tick(); f.allow();
    const blocked = await f.get(item.id); expect(blocked.status).toBe('blocked');
    const attempt = blocked.steps[0]!.attempts[0]!;
    // 即使 Task 已终态（在数据库中落为 cancelled），没有物理停止证明仍不代表资源安全；cancellation 仍必须 blocked。
    const db = new Database(join(f.directory, 'test.db'));
    try {
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(attempt.taskId);
    } finally { db.close(); }
    const cancelled = await f.service.cancel(f.parent.id, item.id, blocked.revision, 'ou_owner');
    expect(cancelled.status).toBe('blocked'); expect(cancelled.steps[0]!.status).toBe('blocked');
    expect(f.stopped).toContain(attempt.sessionId);
    expect(JSON.parse((await f.repos.config.get('work_item:' + item.id))!).stoppedAttempts).toEqual([]);
    expect(f.deliveries).not.toHaveBeenCalled();
  });

  it('isolates hanging notifications and deliveries, and fences late responses after close', async () => {
    const f = await fixture(); let releaseNotify!: () => void; let releaseDelivery!: () => void;
    const notification = new Promise<void>(resolve => { releaseNotify = resolve; });
    const delivery = new Promise<void>(resolve => { releaseDelivery = resolve; });
    const waitPlan: WorkPlan = { title: 'Wait', steps: [
      { id: 'wait', title: 'Approve', kind: 'wait', instruction: 'Approve?', dependsOn: [] },
      { ...plan.steps[0]!, dependsOn: ['wait'] }
    ], outputStepId: 'a' };
    const waiting = await f.create(waitPlan, 'waiting-notification');
    f.notifications.mockImplementation(async item => { if (item.id === waiting.id) await notification; });
    await f.tick();
    const first = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }, 'hanging-delivery');
    f.deliveries.mockImplementation(async item => { if (item.id === first.id) await delivery; });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'First complete'); await f.tick();
    expect(f.deliveries).toHaveBeenCalledTimes(1);
    const second = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }, 'independent-delivery');
    await f.tick(); await eventually(async () => f.calls.length === 2);
    await f.finish(f.calls[1]!, 'Second complete'); await f.tick();
    await eventually(async () => (await f.get(second.id)).delivery.status === 'delivered');
    await f.tick();
    expect(f.notifications.mock.calls.filter(([item]) => item.id === waiting.id)).toHaveLength(1);
    expect(f.deliveries.mock.calls.filter(([item]) => item.id === first.id)).toHaveLength(1);
    expect((await f.get(first.id)).delivery.status).toBe('pending');
    const started = Date.now(); await f.service.close(); expect(Date.now() - started).toBeLessThan(500);
    const read = vi.spyOn(f.repos.config, 'get');
    if (!f.repos.config.compareAndSet) throw new Error('compareAndSet required');
    const configWithCas = f.repos.config as Required<Pick<typeof f.repos.config, 'compareAndSet'>> & typeof f.repos.config;
    const write = vi.spyOn(configWithCas, 'compareAndSet');
    try {
      releaseNotify(); releaseDelivery(); await new Promise(resolve => setTimeout(resolve, 30));
      expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    } finally { read.mockRestore(); write.mockRestore(); releaseNotify(); releaseDelivery(); }
  });

  it('does not overwrite a newer terminal state when delivery resolves late', async () => {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); f.deliveries.mockImplementation(async () => gate);
    const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' });
    await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'Ready'); await f.tick(); expect(f.deliveries).toHaveBeenCalledTimes(1);
    const key = 'work_item:' + item.id; const raw = (await f.repos.config.get(key))!;
    const newer = JSON.parse(raw); newer.item.status = 'cancelled'; newer.item.delivery.status = 'not_requested'; newer.item.revision++;
    expect(await f.repos.config.compareAndSet!(key, raw, JSON.stringify(newer))).toBe(true);
    release(); await new Promise(resolve => setTimeout(resolve, 30));
    expect(await f.get(item.id)).toMatchObject({ status: 'cancelled', revision: newer.item.revision, delivery: { status: 'not_requested' } });
  });

});

const reviewPlan = (maxReworkRounds = 2): WorkPlan => ({ ...plan, steps: plan.steps.map(step => step.id === 'join'
  ? { ...step, reviewPolicy: { maxReworkRounds, allowedTargetStepIds: ['b'] } } : step) });
const reviewedInputs = (call: Call) => JSON.parse(call.prompt.split('Upstream inputs (generated results, not independent business verification):\n')[1]!.split('\n\n')[0]!) as Array<{ stepId: string; attemptId: string; generatedResult: { digest: string }; workspace: { cwd: string } }>;
const reviewVerdict = (call: Call, decision: 'accept' | 'rework' | 'stop', feedback = 'Verified acceptance criteria', patch: Record<string, unknown> = {}) => JSON.stringify({
  decision, reviewed: reviewedInputs(call).map(input => ({ stepId: input.stepId, attemptId: input.attemptId, digest: input.generatedResult.digest })),
  ...(decision === 'rework' ? { targetStepId: 'b' } : {}), feedback, ...patch
});
async function reachReview(f: Awaited<ReturnType<typeof fixture>>, custom = reviewPlan()) {
  const item = await f.create(custom);
  await f.tick(); await eventually(async () => f.calls.length === 1);
  await f.finish(f.calls[0]!, 'Context evidence'); await f.tick(); await eventually(async () => f.calls.length === 2);
  await f.finish(f.calls[1]!, 'Implementation version 1');
  await f.tick(); await eventually(async () => f.calls.length === 3);
  return item;
}

describe('Bounded independent review with real Runtime and SQLite', () => {
  it('rejects reviews on intermediate steps, upstream targets, duplicate targets and self-review', () => {
    expect(() => workPlanSchema.parse(reviewPlan())).not.toThrow();
    const withSteps = (steps: WorkPlan['steps']) => ({ ...reviewPlan(), steps });
    expect(() => workPlanSchema.parse(withSteps(reviewPlan().steps.map(step => step.id === 'a' ? { ...step, reviewPolicy: { maxReworkRounds: 1, allowedTargetStepIds: ['b'] } } : step)))).toThrow();
    expect(() => workPlanSchema.parse(withSteps(reviewPlan().steps.map(step => step.id === 'a' ? { ...step, dependsOn: ['b'] } : step)))).toThrow();
    expect(() => workPlanSchema.parse(withSteps(reviewPlan().steps.map(step => step.id === 'join' ? { ...step, reviewPolicy: { maxReworkRounds: 1, allowedTargetStepIds: ['b', 'b'] } } : step)))).toThrow();
    expect(() => workPlanSchema.parse(withSteps(reviewPlan().steps.map(step => step.id === 'b' ? { ...step, agentId: 'alpha' } : step)))).toThrow();
  });

  it('reworks in the original git worktree across restart, preserving uncommitted files and unrelated steps', async () => {
    const f = await fixture('confirmed', true);
    const custom = reviewPlan(); custom.steps = custom.steps.map(step => step.id === 'b' ? { ...step, workspaceMode: 'worktree' } : step);
    const item = await f.create(custom);
    await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'Context evidence'); await f.tick(); await eventually(async () => f.calls.length === 2);
    const firstWorkspace = (await f.runtime.getWorkspace(f.calls[1]!.sessionId))!;
    expect(firstWorkspace.mode).toBe('worktree'); expect(firstWorkspace.cwd).not.toBe(f.parent.cwd);
    await writeFile(join(firstWorkspace.cwd, 'feature.txt'), 'version one');
    await f.finish(f.calls[1]!, 'Implementation version 1');
    await f.tick(); await eventually(async () => f.calls.length === 3);
    expect(reviewedInputs(f.calls[2]!).find(input => input.stepId === 'b')!.workspace.cwd).toBe(firstWorkspace.cwd);
    expect(await readFile(join(firstWorkspace.cwd, 'feature.txt'), 'utf8')).toBe('version one');
    await f.finish(f.calls[2]!, reviewVerdict(f.calls[2]!, 'rework', 'Add the missing edge case'));
    await f.tick();
    expect((await f.get(item.id)).steps.map(step => step.status)).toEqual(['completed', 'pending', 'pending']);
    await f.reboot(); await f.tick(); await eventually(async () => f.calls.length === 4);
    const reworkWorkspace = (await f.runtime.getWorkspace(f.calls[3]!.sessionId))!;
    expect(reworkWorkspace).toMatchObject({ mode: 'shared', cwd: firstWorkspace.cwd });
    expect(await readFile(join(reworkWorkspace.cwd, 'feature.txt'), 'utf8')).toBe('version one');
    expect(f.calls[3]!.prompt).toContain('Add the missing edge case');
    await writeFile(join(reworkWorkspace.cwd, 'feature.txt'), 'version two');
    await f.finish(f.calls[3]!, 'Implementation version 2, edge case verified');
    await f.tick(); await eventually(async () => f.calls.length === 5);
    expect(await readFile(join(reviewedInputs(f.calls[4]!).find(input => input.stepId === 'b')!.workspace.cwd, 'feature.txt'), 'utf8')).toBe('version two');
    expect(f.calls[4]!.prompt).toContain('Add the missing edge case');
    const final = reviewVerdict(f.calls[4]!, 'accept', '验收结论：通过\nBoth file and edge case verified');
    await f.finish(f.calls[4]!, final); await f.tick();
    const done = await f.get(item.id);
    expect(done.status).toBe('completed'); expect(done.output!.text).toBe('验收结论：通过\nBoth file and edge case verified');
    expect(done.steps.map(step => step.attempts.length)).toEqual([1, 2, 2]);
    expect(done.steps[2]!.attempts.map(attempt => attempt.review?.decision)).toEqual(['rework', 'accept']);
    expect(done.steps[2]!.attempts[1]!.output!.text).toBe(final);
    await f.tick(); expect(f.calls).toHaveLength(5); expect(f.deliveries).toHaveBeenCalledTimes(1);
    await expect(readFile(join(f.parent.cwd, 'feature.txt'), 'utf8')).rejects.toThrow();
  });

  it.each(['stop', 'limit', 'stale', 'missing', 'duplicate', 'foreign', 'malformed'] as const)('blocks %s verdicts without reporting completion or launching another worker', async kind => {
    const f = await fixture(); const item = await reachReview(f, reviewPlan(kind === 'limit' ? 0 : 2));
    const call = f.calls[2]!; const refs = reviewedInputs(call).map(input => ({ stepId: input.stepId, attemptId: input.attemptId, digest: input.generatedResult.digest }));
    const patch = kind === 'stale' ? { reviewed: refs.map(ref => ({ ...ref, attemptId: 'old-attempt' })) }
      : kind === 'missing' ? { reviewed: refs.slice(0, 1) }
      : kind === 'duplicate' ? { reviewed: [refs[0], refs[0]] }
      : kind === 'foreign' ? { targetStepId: 'a' } : {};
    const text = kind === 'malformed' ? '验收结论：需返修' : reviewVerdict(call, ['limit', 'foreign'].includes(kind) ? 'rework' : kind === 'stop' ? 'stop' : 'accept', 'Unresolved issue', patch);
    await f.finish(call, text); await f.tick();
    expect((await f.get(item.id)).status).toBe('blocked'); expect((await f.get(item.id)).output).toBeUndefined();
    expect((await f.get(item.id)).steps[2]!.attempts[0]!.output!.text).toBe(text);
    await f.recreateService(); await f.tick(); expect(f.calls).toHaveLength(3); expect(f.deliveries).not.toHaveBeenCalled();
  });

  it('accepts one final review block after multiple tool commentary chunks', async () => {
    const f = await fixture(); const item = await reachReview(f); const call = f.calls[2]!;
    const verdict = reviewVerdict(call, 'accept', 'Files and acceptance checks verified');
    const chunks = ['I will inspect the implementation.\n', 'The implementation matches the checks.\n', '```dutydeck-review\n' + verdict + '\n```'];
    await f.finish(call, chunks); await f.tick();
    const done = await f.get(item.id);
    expect(done.status).toBe('completed'); expect(done.output!.text).toBe('Files and acceptance checks verified');
    expect(done.steps[2]!.attempts[0]!.output!.text).toBe(chunks.join(''));
  });

  it.each(['conflicting', 'trailing'] as const)('rejects %s content around review blocks', async kind => {
    const f = await fixture(); const item = await reachReview(f); const call = f.calls[2]!;
    const fenced = (decision: 'accept' | 'stop') => '```dutydeck-review\n' + reviewVerdict(call, decision) + '\n```';
    await f.finish(call, kind === 'conflicting' ? [fenced('stop') + '\n', fenced('accept')] : [fenced('accept'), '\nActually, a test failed.']);
    await f.tick(); expect((await f.get(item.id)).status).toBe('blocked'); expect(f.deliveries).not.toHaveBeenCalled();
  });

  it('preserves the latest findings when the next reviewer fails and is retried', async () => {
    const f = await fixture(); const item = await reachReview(f);
    const finding = 'Reject an empty token and add the regression check';
    const originalVerdict = reviewVerdict(f.calls[2]!, 'rework', finding);
    await f.finish(f.calls[2]!, originalVerdict); await f.tick(); await f.tick();
    await eventually(async () => f.calls.length === 4);
    expect(f.calls[3]!.prompt).toContain(finding);
    await f.finish(f.calls[3]!, 'Implementation version 2: empty tokens rejected and tested'); await f.tick();
    await eventually(async () => f.calls.length === 5);
    expect(f.calls[4]!.prompt).toContain(finding);
    expect(f.calls[4]!.prompt).toContain('Verify the previous findings against the new artifacts as well as the acceptance criteria.');
    const currentInputs = reviewedInputs(f.calls[4]!);
    const implementationRef = currentInputs.find(input => input.stepId === 'b')!;
    expect(implementationRef.attemptId).toBe((await f.get(item.id)).steps[1]!.attempts[1]!.id);
    await f.finish(f.calls[4]!, 'Reviewer process failed before a verdict', true); await f.tick();
    const failed = await f.get(item.id);
    expect(failed.status).toBe('failed');
    await f.service.retryStep(f.parent.id, item.id, 'join', failed.revision, 'ou_owner');
    await f.recreateService(); await f.tick(); await eventually(async () => f.calls.length === 6);
    expect(f.calls[5]!.prompt).toContain(finding);
    expect(f.calls[5]!.prompt).toContain('Verify the previous findings against the new artifacts as well as the acceptance criteria.');
    expect(reviewedInputs(f.calls[5]!)).toEqual(currentInputs);
    await f.finish(f.calls[5]!, reviewVerdict(f.calls[5]!, 'accept', 'Verified the finding and all acceptance checks')); await f.tick();
    const done = await f.get(item.id);
    expect(done.status).toBe('completed');
    expect(done.steps.map(step => step.attempts.length)).toEqual([1, 2, 3]);
    expect(done.steps[2]!.attempts[0]!.output!.text).toBe(originalVerdict);
    expect(done.steps[2]!.attempts[0]!.review).toEqual(JSON.parse(originalVerdict));
    expect(done.steps[2]!.attempts[2]!.review!.reviewed.find(ref => ref.stepId === 'b')).toEqual({ stepId: 'b', attemptId: implementationRef.attemptId, digest: implementationRef.generatedResult.digest });
  });

  it('enforces the positive rework limit across persisted rounds', async () => {
    const f = await fixture(); const item = await reachReview(f, reviewPlan(1));
    await f.finish(f.calls[2]!, reviewVerdict(f.calls[2]!, 'rework', 'Fix edge case')); await f.tick(); await f.tick();
    await eventually(async () => f.calls.length === 4); await f.finish(f.calls[3]!, 'Version 2'); await f.tick();
    await eventually(async () => f.calls.length === 5);
    await f.finish(f.calls[4]!, reviewVerdict(f.calls[4]!, 'rework', 'Still failing')); await f.tick();
    expect(await f.get(item.id)).toMatchObject({ status: 'blocked', error: 'Review rework limit reached: Still failing' });
    await f.reboot(); await f.tick(); expect(f.calls).toHaveLength(5);
  });

  it.each([['agent', true], ['human', false]] as const)('review rounds superseded by the %s revision count toward the rework limit: %s', async (source, limited) => {
    const f = await fixture(); const item = await reachReview(f, reviewPlan(1));
    await f.finish(f.calls[2]!, reviewVerdict(f.calls[2]!, 'rework', 'Fix edge case')); await f.tick(); await f.tick();
    await eventually(async () => f.calls.length === 4); await f.finish(f.calls[3]!, 'Version 2'); await f.tick();
    await eventually(async () => f.calls.length === 5);
    // 把第一轮返工的审查尝试标成被某次修订作废：Agent 修订作废的仍计数，人提交的修订作废的不计。
    const key = `work_item:${item.id}`; const raw = (await f.repos.config.get(key))!; const record = JSON.parse(raw);
    const time = new Date().toISOString();
    record.item.planVersion = 2;
    record.item.planHistory = [{ version: 1, plan: reviewPlan(1), createdAt: time, source: 'create' }, { version: 2, plan: reviewPlan(1), createdAt: time, source, actor: 'creator' }];
    record.item.steps[2].attempts[0].supersededByPlanVersion = 2;
    expect(await f.repos.config.compareAndSet!(key, raw, JSON.stringify(record))).toBe(true);
    await f.finish(f.calls[4]!, reviewVerdict(f.calls[4]!, 'rework', 'Still failing')); await f.tick();
    if (limited) {
      expect(await f.get(item.id)).toMatchObject({ status: 'blocked', error: 'Review rework limit reached: Still failing' });
      await f.tick(); expect(f.calls).toHaveLength(5);
    } else await eventually(async () => { await f.tick(); return f.calls.length === 6; });
  });

  it.each(['cancel', 'revoke'] as const)('does not dispatch a rework after %s', async action => {
    const f = await fixture(); const item = await reachReview(f);
    await f.finish(f.calls[2]!, reviewVerdict(f.calls[2]!, 'rework', 'Fix edge case')); await f.tick();
    if (action === 'cancel') {
      const current = await f.get(item.id); await f.service.cancel(f.parent.id, item.id, current.revision, 'ou_owner');
    } else f.denyAgent('beta');
    await f.tick();
    expect((await f.get(item.id)).status).toBe(action === 'cancel' ? 'cancelled' : 'blocked');
    expect(f.calls).toHaveLength(3); expect(f.deliveries).not.toHaveBeenCalled();
  });

  it('does not reuse a worktree whose persisted ownership changed', async () => {
    const f = await fixture(); const item = await reachReview(f);
    await f.finish(f.calls[2]!, reviewVerdict(f.calls[2]!, 'rework', 'Fix edge case')); await f.tick();
    const key = 'runtime_workspace:' + f.calls[1]!.sessionId;
    const workspace = JSON.parse((await f.repos.config.get(key))!); workspace.cwd = join(f.directory, 'different');
    await f.repos.config.set(key, JSON.stringify(workspace)); await f.tick();
    expect((await f.get(item.id)).status).toBe('blocked'); expect(f.calls).toHaveLength(3);
  });
});

describe('Plan revision with real Runtime and SQLite', () => {
  const stored = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => JSON.parse((await f.repos.config.get(`work_item:${id}`))!);
  /** a、b 完成，join 运行中。 */
  async function joinRunning(f: Awaited<ReturnType<typeof fixture>>) {
    const item = await f.create();
    for (const [index, text] of ['First result', 'Second result'].entries()) {
      await eventually(async () => { await f.tick(); return f.calls.length === index + 1; });
      await f.finish(f.calls[index]!, text);
    }
    await eventually(async () => { await f.tick(); return f.calls.length === 3; });
    return item;
  }
  /** 被停止的运行结果未知：只有人工核对（这里标为失败）后，同一仓库才会开始重跑。 */
  async function reconcileStopped(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
    const old = f.repos.execution.getSessionExecutions(sessionId)[0]!;
    expect(old.currentAttempt).toMatchObject({ state: 'reconcile_required', reconcileReason: { code: 'STOP_RESULT_UNKNOWN' } });
    const facts = await f.runtime.inspectUnknownTask(sessionId, old.task.id);
    await f.runtime.resolveUnknownTask(sessionId, { taskId: old.task.id, target: facts.target!, decisionId: `test:${sessionId}`, action: 'failed', evidenceRefs: ['fixture:stopped-by-revision-reviewed'] }, { kind: 'installation_owner', id: 'installation_owner' });
  }
  const withJoin = (instruction: string): WorkPlan => ({ ...plan, steps: plan.steps.map(step => step.id === 'join' ? { ...step, instruction } : step) });

  it('keeps unaffected results, stops and reruns the changed running step, and records the version history', async () => {
    const f = await fixture(); const item = await joinRunning(f);
    const running = await f.get(item.id); const oldJoin = running.steps[2]!.attempts[0]!;
    const preview = await f.service.previewRevision(f.parent.id, item.id, { expectedRevision: running.revision, plan: withJoin('Compare and rank both results') }, 'ou_owner');
    expect(preview).toMatchObject({ planVersion: 1, nextVersion: 2, requiresConfirmation: false, impact: { keep: ['a', 'b'], rerun: ['join'], stop: ['join'], remove: [], add: [] } });
    expect((await f.get(item.id)).revision).toBe(running.revision);
    expect(f.stopped).not.toContain(oldJoin.sessionId);
    const revised = await f.service.revise(f.parent.id, item.id, { expectedRevision: running.revision, plan: withJoin('Compare and rank both results'), reason: '需要排序' }, 'ou_owner');
    expect(f.stopped).toContain(oldJoin.sessionId);
    expect(revised).toMatchObject({ planVersion: 2, status: 'running', steps: [{ status: 'completed' }, { status: 'completed' }, { status: 'pending' }] });
    expect(revised.steps[2]!.attempts[0]).toMatchObject({ supersededByPlanVersion: 2, status: 'interrupted' });
    expect(revised.planHistory!.map(version => [version.version, version.source, version.actor, version.reason])).toEqual([[1, 'create', undefined, undefined], [2, 'human', 'creator', '需要排序']]);
    expect(revised.planHistory![0]!.plan).toEqual(plan);
    expect(JSON.stringify(revised)).not.toContain('ou_owner');
    await expect(f.service.authorizeExecution(oldJoin.sessionId!, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_TASK_REVOKED' });
    for (let round = 0; round < 3; round++) await f.tick();
    expect(f.calls).toHaveLength(3);
    await reconcileStopped(f, oldJoin.sessionId!);
    await eventually(async () => { await f.tick(); return f.calls.length === 4; });
    expect(f.calls[3]!.prompt).toContain('Compare and rank both results');
    expect(f.calls[3]!.prompt).toContain('First result'); expect(f.calls[3]!.prompt).toContain('Second result');
    expect(f.calls[3]!.sessionId).not.toBe(oldJoin.sessionId);
    await f.finish(f.calls[3]!, 'Ranked comparison'); await f.tick();
    const done = await f.get(item.id);
    expect(done).toMatchObject({ status: 'completed', output: { text: 'Ranked comparison' } });
    expect(done.steps[0]!.attempts).toHaveLength(1); expect(done.steps[1]!.attempts).toHaveLength(1);
    expect(f.calls).toHaveLength(4);
  });

  it('rejects stale and concurrent revisions so only one plan wins', async () => {
    const f = await fixture(); f.gate(); const item = await f.create();
    await expect(f.service.revise(f.parent.id, item.id, { expectedRevision: item.revision + 1, plan: withJoin('x') }, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_CONFLICT', statusCode: 409 });
    const results = await Promise.allSettled([withJoin('first'), withJoin('second')].map(next => f.service.revise(f.parent.id, item.id, { expectedRevision: item.revision, plan: next }, 'ou_owner')));
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'WORK_ITEM_CONFLICT' });
    const current = await f.get(item.id);
    // 未确认的初始计划改了仍待确认，不派发。
    expect(current).toMatchObject({ planVersion: 2, status: 'awaiting_confirmation' });
    await expect(f.service.revise(f.parent.id, item.id, { expectedRevision: current.revision, plan: current.plan }, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_EMPTY' });
    await expect(f.service.revise(f.parent.id, item.id, { expectedRevision: current.revision, plan: withJoin('other') }, 'ou_other')).rejects.toMatchObject({ statusCode: 403 });
    await f.tick(); expect(f.calls).toHaveLength(0);
  });

  it('refuses unauthorized new Agents', async () => {
    const f = await fixture(); const item = await f.create({ ...plan, steps: plan.steps.map(step => ({ ...step, agentId: 'alpha' })) });
    f.denyAgent('beta');
    await expect(f.service.previewRevision(f.parent.id, item.id, { expectedRevision: item.revision, plan }, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_AGENT_FORBIDDEN' });
  });

  it.each(['unproven', 'throws'] as const)('keeps the original plan when a running step cannot be proven stopped (%s)', async outcome => {
    const f = await fixture(); const item = await joinRunning(f);
    const before = await stored(f, item.id);
    const stop = vi.spyOn(f.runtime, 'stopWorkItemSession');
    if (outcome === 'throws') stop.mockRejectedValue(new Error('driver unreachable')); else stop.mockResolvedValue(false);
    await expect(f.service.revise(f.parent.id, item.id, { expectedRevision: before.item.revision, plan: withJoin('Changed') }, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_STOP_FAILED', statusCode: 409 });
    expect(stop).toHaveBeenCalledWith(f.calls[2]!.sessionId, expect.anything());
    expect(await stored(f, item.id)).toEqual(before);
    stop.mockRestore();
    await f.finish(f.calls[2]!, 'Original comparison'); await f.tick();
    expect(await f.get(item.id)).toMatchObject({ status: 'completed', planVersion: 1, plan, output: { text: 'Original comparison' } });
    expect(f.calls).toHaveLength(3);
  });

  it('is all-old after a restart between the stop and the commit, and never resends the stopped step', async () => {
    const f = await fixture(); const item = await joinRunning(f);
    const before = await f.get(item.id);
    const cas = f.repos.config.compareAndSet!.bind(f.repos.config);
    const crash = vi.spyOn(f.repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) => {
      if (key === `work_item:${item.id}` && value.includes('"planVersion":2')) throw new Error('process exited');
      return cas(key, expected, value);
    });
    await expect(f.service.revise(f.parent.id, item.id, { expectedRevision: before.revision, plan: withJoin('Changed') }, 'ou_owner')).rejects.toThrow('process exited');
    crash.mockRestore();
    expect(f.stopped).toContain(before.steps[2]!.attempts[0]!.sessionId);
    await f.reboot(); await f.tick(); await f.tick();
    const after = await f.get(item.id);
    expect(after).toMatchObject({ planVersion: 1, plan, status: 'blocked' });
    expect(after.steps.map(step => step.status)).toEqual(['completed', 'completed', 'blocked']);
    expect(f.calls).toHaveLength(3);
    await expect(f.service.revise(f.parent.id, item.id, { expectedRevision: after.revision, plan: withJoin('Changed') }, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_UNSAFE' });
  });

  it('lets an Agent narrow the plan directly but holds widening changes for human confirmation while the current plan keeps running, across a restart', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 1);
    let current = await f.get(item.id);
    const narrowed = withJoin('Short comparison');
    current = await f.service.revise(f.parent.id, item.id, { expectedRevision: current.revision, plan: narrowed }, 'ou_owner', 'agent');
    expect(current).toMatchObject({ planVersion: 2, status: 'running' });
    expect(current.planHistory!.at(-1)).toMatchObject({ source: 'agent', actor: 'creator' });
    const widened: WorkPlan = { ...narrowed, steps: [...narrowed.steps.slice(0, 2), { id: 'extra', title: 'Extra', kind: 'agent', agentId: 'beta', instruction: 'More', dependsOn: [] }, { ...narrowed.steps[2]!, dependsOn: ['a', 'b', 'extra'] }] };
    const preview = await f.service.previewRevision(f.parent.id, item.id, { expectedRevision: current.revision, plan: widened }, 'ou_owner', 'agent');
    expect(preview).toMatchObject({ requiresConfirmation: true, confirmationReasons: ['新增步骤 extra'] });
    current = await f.service.revise(f.parent.id, item.id, { expectedRevision: current.revision, plan: widened, reason: 'needs more evidence' }, 'ou_owner', 'agent');
    // 待确认修订不改状态：计划冻结在 v2，目标仍是 running。
    expect(current).toMatchObject({ status: 'running', planVersion: 2, plan: narrowed, pendingRevision: { version: 3, reason: 'needs more evidence', impact: { add: ['extra'], rerun: ['join'] }, digest: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const digest = current.pendingRevision!.digest;
    await f.finish(f.calls[0]!, 'First result');
    await f.reboot();
    // 待确认期间照常收运行中步骤的结果，并按当前生效的 v2 派发下一步。
    await eventually(async () => { await f.tick(); return f.calls.length === 2; });
    expect(f.calls[1]!.prompt).toContain('Research B');
    current = await f.get(item.id);
    expect(current).toMatchObject({ status: 'running', planVersion: 2, plan: narrowed, pendingRevision: { version: 3, digest } });
    expect(current.steps.map(step => step.status)).toEqual(['completed', 'running', 'pending']);
    await expect(f.service.confirm(f.parent.id, item.id, current.revision, 'ou_other')).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.service.confirm(f.parent.id, item.id, current.revision, 'ou_owner', 'f'.repeat(64))).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_CONFIRM_MISMATCH', statusCode: 409 });
    // 带摘要确认只认内容：调度推进 revision 之后，旧 revision 加正确摘要仍可确认。
    current = await f.service.confirm(f.parent.id, item.id, current.revision - 1, 'ou_owner', digest);
    expect(current).toMatchObject({ planVersion: 3, status: 'running', plan: widened });
    expect(current.pendingRevision).toBeUndefined();
    expect(current.planHistory!.at(-1)).toMatchObject({ version: 3, source: 'agent', reason: 'needs more evidence' });
    await f.finish(f.calls[1]!, 'Second result');
    await eventually(async () => { await f.tick(); return f.calls.length === 3; });
    expect(f.calls[2]!.prompt).toContain('More');
  });

  it('replacing a pending revision changes its digest, and confirming with the old digest is rejected', async () => {
    const f = await fixture(); f.gate(); const item = await f.create();
    let current = await f.service.confirm(f.parent.id, item.id, item.revision, 'ou_owner');
    current = await f.service.revise(f.parent.id, item.id, { expectedRevision: current.revision, plan: withJoin('Narrow one') }, 'ou_owner', 'agent');
    const first = current.pendingRevision!;
    current = await f.service.revise(f.parent.id, item.id, { expectedRevision: current.revision, plan: withJoin('Narrow two') }, 'ou_owner', 'agent');
    const second = current.pendingRevision!;
    expect(second.version).toBe(first.version);
    expect(second.digest).not.toBe(first.digest);
    await expect(f.service.confirm(f.parent.id, item.id, current.revision, 'ou_owner', first.digest)).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_CONFIRM_MISMATCH' });
    await expect(f.service.discardRevision(f.parent.id, item.id, current.revision, 'ou_owner', first.digest)).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_CONFIRM_MISMATCH' });
    expect((await f.get(item.id)).pendingRevision?.digest).toBe(second.digest);
    current = await f.service.confirm(f.parent.id, item.id, current.revision, 'ou_owner', second.digest);
    expect(current.plan).toEqual(withJoin('Narrow two'));
  });

  it('refuses a confirmation whose stop or discarded results grew since the revision was shown, and refreshes impact and digest', async () => {
    const f = await fixture(); f.gate(); const item = await f.create();
    let current = await f.service.confirm(f.parent.id, item.id, item.revision, 'ou_owner');
    await f.tick(); await eventually(async () => f.calls.length === 1);
    expect(f.calls[0]!.prompt).toContain('Research A');
    const withB = { ...plan, steps: plan.steps.map(step => step.id === 'b' ? { ...step, instruction: 'Research B with sources' } : step) };
    current = await f.service.revise(f.parent.id, item.id, { expectedRevision: (await f.get(item.id)).revision, plan: withB }, 'ou_owner', 'agent');
    // 提交时 b 还没开始：卡片上「先停止」为空。
    const shown = current.pendingRevision!;
    expect(shown.impact).toMatchObject({ rerun: ['b', 'join'], stop: [], discard: [] });
    // 等待确认期间 b 开始运行。
    await f.finish(f.calls[0]!, 'First result');
    await eventually(async () => { await f.tick(); return f.calls.length === 2; });
    const runningB = f.calls[1]!.sessionId;
    await expect(f.service.confirm(f.parent.id, item.id, 1, 'ou_owner', shown.digest)).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_IMPACT_CHANGED', statusCode: 409 });
    current = await f.get(item.id);
    expect(f.stopped).not.toContain(runningB);
    expect(current).toMatchObject({ planVersion: 1, plan, pendingRevision: { version: shown.version, impact: { stop: ['b'], discard: [] } } });
    const refreshed = current.pendingRevision!;
    expect(refreshed.digest).not.toBe(shown.digest);
    // 旧卡片、旧待处理条目带着旧摘要，不能再确认。
    await expect(f.service.confirm(f.parent.id, item.id, 1, 'ou_owner', shown.digest)).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_CONFIRM_MISMATCH' });
    // 再等一会儿 b 完成、join 开始运行：b 从「先停止」变成「作废」已经看到过，新出现的是要停止的 join。
    await f.finish(f.calls[1]!, 'Second result');
    await eventually(async () => { await f.tick(); return f.calls.length === 3; });
    await expect(f.service.confirm(f.parent.id, item.id, 1, 'ou_owner', refreshed.digest)).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_IMPACT_CHANGED', message: expect.stringContaining("stops or discards join;") });
    const latest = (await f.get(item.id)).pendingRevision!;
    expect(latest.impact).toMatchObject({ stop: ['join'], discard: ['b'] });
    expect(latest.acknowledged).toEqual(['b', 'join']);
    current = await f.service.confirm(f.parent.id, item.id, 1, 'ou_owner', latest.digest);
    expect(current).toMatchObject({ planVersion: 2, plan: withB });
    expect(current.steps.find(step => step.id === 'b')!.attempts[0]).toMatchObject({ supersededByPlanVersion: 2 });
    expect(current.planHistory!.at(-1)!.impact).toMatchObject({ discard: ['b'] });
  });

  it('does not refuse again when a step already shown as stopped finishes and is discarded instead', async () => {
    const f = await fixture(); f.gate();
    const gated: WorkPlan = { title: 'Wait before join', outputStepId: 'join', steps: [
      { id: 'b', title: 'Research', kind: 'agent', agentId: 'beta', instruction: 'Research B', dependsOn: [] },
      { id: 'ask', title: 'Ask', kind: 'wait', instruction: 'Proceed?', dependsOn: [] },
      { id: 'join', title: 'Synthesis', kind: 'agent', agentId: 'alpha', instruction: 'Compare', dependsOn: ['b', 'ask'] }
    ] };
    const item = await f.create(gated);
    await f.service.confirm(f.parent.id, item.id, item.revision, 'ou_owner');
    await eventually(async () => { await f.tick(); return f.calls.length === 1; });
    const next = { ...gated, steps: gated.steps.map(step => step.id === 'b' ? { ...step, instruction: 'Research B with sources' } : step) };
    const pending = (await f.service.revise(f.parent.id, item.id, { expectedRevision: (await f.get(item.id)).revision, plan: next }, 'ou_owner', 'agent')).pendingRevision!;
    expect(pending.impact).toMatchObject({ rerun: ['b', 'join'], stop: ['b'], discard: [] });
    // b 跑完：现在是「作废 b」，join 还在等人工回答没开始。
    await f.finish(f.calls[0]!, 'Research result'); await f.tick();
    expect((await f.get(item.id)).steps.map(step => step.status)).toEqual(['completed', 'waiting', 'pending']);
    const confirmed = await f.service.confirm(f.parent.id, item.id, 1, 'ou_owner', pending.digest);
    expect(confirmed).toMatchObject({ planVersion: 2, plan: next });
    expect(confirmed.planHistory!.at(-1)!.impact).toMatchObject({ stop: [], discard: ['b'] });
  });

  it('binds a digest-based first confirmation to the plan the person saw, even after an Agent edits the unconfirmed plan', async () => {
    const f = await fixture(); f.gate(); const item = await f.create();
    const seen = workPlanDigest(item.plan);
    const edited = await f.service.revise(f.parent.id, item.id, { expectedRevision: item.revision, plan: withJoin('Agent changed this') }, 'ou_owner', 'agent');
    expect(edited).toMatchObject({ status: 'awaiting_confirmation', planVersion: 2 });
    await expect(f.service.confirm(f.parent.id, item.id, edited.revision, 'ou_owner', seen)).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_CONFIRM_MISMATCH' });
    expect((await f.get(item.id)).status).toBe('awaiting_confirmation');
    expect(await f.service.confirm(f.parent.id, item.id, edited.revision, 'ou_owner', workPlanDigest(edited.plan))).toMatchObject({ status: 'running', planVersion: 2 });
  });

  it('reports a failed work item with a pending revision as still in progress to schedules and triggers', async () => {
    const f = await fixture(); const item = await f.create();
    const pendingRevision = { version: 2 } as WorkItem['pendingRevision'];
    expect(workItemProgressStatus({ status: 'failed', pendingRevision })).toBe('running');
    expect(workItemProgressStatus({ status: 'failed' })).toBe('failed');
    expect(workItemProgressStatus({ status: 'blocked', pendingRevision })).toBe('blocked');
    const key = `work_item:${item.id}`; const raw = (await f.repos.config.get(key))!; const record = JSON.parse(raw);
    record.item.status = 'failed'; record.item.pendingRevision = pendingRevision;
    expect(await f.repos.config.compareAndSet!(key, raw, JSON.stringify(record))).toBe(true);
    expect(readWorkItemStatus(f.repos.config, item.id)).toBe('running');
  });

  it('rejects a step retry while a revision is pending, and allows it after the revision is discarded', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.finish(f.calls[0]!, 'Kept result'); await f.tick(); await eventually(async () => f.calls.length === 2); await f.finish(f.calls[1]!, '', true); await f.tick();
    let current = await f.get(item.id); expect(current.status).toBe('failed');
    const failedId = current.steps.find(step => step.status === 'failed')!.id;
    // 改已失败的步骤会让它自动重跑，Agent 提交时必须等人确认。
    current = await f.service.revise(f.parent.id, item.id, { expectedRevision: current.revision, plan: { ...plan, steps: plan.steps.map(step => step.id === failedId ? { ...step, instruction: 'Try another source' } : step) } }, 'ou_owner', 'agent');
    expect(current).toMatchObject({ status: 'failed', planVersion: 1, pendingRevision: { confirmationReasons: [`重跑已失败的步骤 ${failedId}`] } });
    await expect(f.service.retryStep(f.parent.id, item.id, failedId, current.revision, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_REVISION_PENDING', statusCode: 409 });
    current = await f.service.discardRevision(f.parent.id, item.id, current.revision, 'ou_owner');
    expect(current).toMatchObject({ status: 'failed', planVersion: 1 });
    expect(current.pendingRevision).toBeUndefined();
    await f.service.retryStep(f.parent.id, item.id, failedId, current.revision, 'ou_owner'); await f.tick();
    await eventually(async () => f.calls.length === 3);
  });

  it.each([['agent', true], ['human', false]] as const)('attempts superseded by the %s revision count toward the retry limit: %s', async (source, limited) => {
    const f = await fixture(); const item = await f.create();
    const key = `work_item:${item.id}`; const raw = (await f.repos.config.get(key))!; const record = JSON.parse(raw);
    const time = new Date().toISOString();
    const attempt = (number: number, superseded?: number) => ({ id: `${item.id}:b:${number}`, number, status: 'failed', createdAt: time, updatedAt: time, ...(superseded ? { supersededByPlanVersion: superseded } : {}) });
    record.item.status = 'failed'; record.item.planVersion = 2;
    record.item.planHistory = [{ version: 1, plan, createdAt: time, source: 'create' }, { version: 2, plan, createdAt: time, source, actor: 'creator' }];
    record.item.steps[1] = { id: 'b', status: 'failed', attempts: [attempt(1, 2), attempt(2, 2), attempt(3)] };
    expect(await f.repos.config.compareAndSet!(key, raw, JSON.stringify(record))).toBe(true);
    const current = await f.get(item.id);
    const retry = f.service.retryStep(f.parent.id, item.id, 'b', current.revision, 'ou_owner');
    if (limited) await expect(retry).rejects.toMatchObject({ code: 'WORK_ITEM_RETRY_UNSAFE' });
    else expect(await retry).toMatchObject({ status: 'running', steps: [{}, { id: 'b', status: 'pending' }, {}] });
  });

  it('requires confirmation for any Agent revision of a gated work item and can discard it', async () => {
    const f = await fixture(); f.gate(); const item = await f.create();
    const confirmed = await f.service.confirm(f.parent.id, item.id, item.revision, 'ou_owner');
    const pending = await f.service.revise(f.parent.id, item.id, { expectedRevision: confirmed.revision, plan: withJoin('Narrow only') }, 'ou_owner', 'agent');
    expect(pending).toMatchObject({ status: 'running', planVersion: 1, plan, pendingRevision: { confirmationReasons: ['本目标要求人工确认计划'] } });
    // 待确认修订期间保存模板，只保存已经确认生效的计划，不带入未确认的修订。
    expect((await f.service.saveTemplate(f.parent.id, item.id, '已确认计划', 'ou_owner')).plan).toEqual(plan);
    const discarded = await f.service.discardRevision(f.parent.id, item.id, pending.revision, 'ou_owner');
    expect(discarded).toMatchObject({ status: 'running', planVersion: 1, plan });
    expect(discarded.pendingRevision).toBeUndefined();
    await expect(f.service.discardRevision(f.parent.id, item.id, discarded.revision, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_NO_PENDING_REVISION' });
    // 人工修订预览后直接生效，不再要求确认。
    expect(await f.service.revise(f.parent.id, item.id, { expectedRevision: discarded.revision, plan: withJoin('Human change') }, 'ou_owner')).toMatchObject({ status: 'running', planVersion: 2 });
  });

  it('retires a removed running step, keeps its child bound, and does not reuse its attempt identity when re-added', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 1);
    const running = await f.get(item.id);
    const removedStep = running.steps.find(step => step.status === 'running' && step.attempts[0]!.sessionId === f.calls[0]!.sessionId)!;
    const keptId = removedStep.id === 'a' ? 'b' : 'a';
    const withoutStep: WorkPlan = { ...plan, steps: plan.steps.filter(step => step.id !== removedStep.id).map(step => step.id === 'join' ? { ...step, dependsOn: [keptId] } : step) };
    const revised = await f.service.revise(f.parent.id, item.id, { expectedRevision: running.revision, plan: withoutStep }, 'ou_owner');
    expect(f.stopped).toContain(f.calls[0]!.sessionId);
    expect(revised.retiredSteps).toMatchObject([{ id: removedStep.id, attempts: [{ supersededByPlanVersion: 2 }] }]);
    expect(await f.service.parentForSession(f.calls[0]!.sessionId)).toMatchObject({ workId: item.id, stepId: removedStep.id });
    // 停下的那次执行结果未知：核对前同一工作区不开始任何新步骤（保留的另一步也在等）。
    for (let round = 0; round < 3; round++) await f.tick();
    expect(f.calls).toHaveLength(1);
    expect((await f.get(item.id)).steps.find(step => step.id === keptId)).toMatchObject({ status: 'pending', attempts: [] });
    await expect(f.service.authorizeExecution(f.calls[0]!.sessionId, 'ou_owner')).rejects.toMatchObject({ code: 'WORK_ITEM_TASK_REVOKED' });
    const readded = await f.service.revise(f.parent.id, item.id, { expectedRevision: revised.revision, plan }, 'ou_owner');
    expect(readded.retiredSteps).toBeUndefined();
    expect(readded.steps.find(step => step.id === removedStep.id)!.attempts).toHaveLength(1);
    await reconcileStopped(f, f.calls[0]!.sessionId);
    await eventually(async () => { await f.tick(); return (await f.get(item.id)).steps.find(step => step.id === removedStep.id)!.attempts.length === 2; });
    const attempts = (await f.get(item.id)).steps.find(step => step.id === removedStep.id)!.attempts;
    expect(attempts[1]).toMatchObject({ number: 2 });
    expect(attempts[1]!.sessionId).not.toBe(attempts[0]!.sessionId);
    expect(new Set(f.calls.map(call => call.sessionId)).size).toBe(f.calls.length);
  });
});
