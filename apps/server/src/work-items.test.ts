import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, workPlanSchema, type AgentDriver, type WorkItem, type WorkPlan } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { WorkItemService } from './work-items.js';

const cleanup: Array<() => Promise<void>> = [];
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
interface Call { sessionId: string; prompt: string; finish: (text: string, failed?: boolean) => void }
async function fixture(stopProof: 'confirmed' | 'missing' | 'unproven' = 'confirmed') {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-work-items-'));
  const repos = createRepositories(join(directory, 'test.db'));
  const agents = ['alpha', 'beta'].map(id => agentConfigSchema.parse({ id, name: id, command: 'fake', protocol: 'acp', cwd: directory, permissionMode: 'ask' }));
  const calls: Call[] = []; const stopped: string[] = [];
  let beforeSubmit: (() => Promise<void>) | undefined;
  let beforeStart: (() => Promise<void>) | undefined;
  const deniedAgents = new Set<string>();
  let allowed = true; let service: WorkItemService; let runtime: DutydeckRuntime;
  const deliveries = vi.fn(async (_item: WorkItem) => {});
  const notifications = vi.fn(async (_item: WorkItem, _actorId: string) => {});
  const makeRuntime = () => new DutydeckRuntime(repos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    probe: (() => ({ available: true, protocol: 'acp', acp: true, jsonl: false, pipe: false, pty: false })) as any,
    authorizeExecution: async (id, actor) => { await service.authorizeExecution(id, actor); },
    sessionPrompt: async (session, prompt) => { if (session.source === 'work_item') await beforeSubmit?.(); return prompt; },
    authorizeTask: (session, task, phase) => service.authorizeTask(session, task, phase),
    driverFactory: (_agent, _protocol, onEvent, _onExit, sessionId) => {
      let current: (() => void) | undefined;
      return {
        start: async () => { if (sessionId.startsWith('ses_work_')) await beforeStart?.(); }, resume: async () => {}, interrupt: async () => { current?.(); },
        stop: async () => { stopped.push(sessionId); current?.(); },
        ...(stopProof === 'missing' ? {} : { isStopped: async () => stopProof === 'confirmed' && stopped.includes(sessionId) }),
        send: (prompt: string) => new Promise<void>(resolve => {
          current = () => { onEvent({ type: 'completed', data: { stopReason: 'cancelled' } }); resolve(); };
          calls.push({ sessionId, prompt, finish(text, failed) {
            if (failed) onEvent({ type: 'error', data: { message: 'Synthetic failure' } });
            if (text) onEvent({ type: 'text', data: { text } });
            onEvent({ type: 'completed', data: { stopReason: 'end_turn' } }); current = undefined; resolve();
          } });
        })
      } satisfies AgentDriver;
    }
  });
  const makeService = () => new WorkItemService({ repositories: repos, runtime, authorize: async (_id, actor) => allowed && (actor === 'ou_owner' || actor === 'installation_owner'), authorizeAgent: async (_parent, _actor, id) => !deniedAgents.has(id), deliver: deliveries, notify: notifications });
  runtime = makeRuntime(); service = makeService(); await runtime.initialize(agents);
  const parent = await runtime.start({ agentId: 'alpha', cwd: directory, source: 'lark', permissionMode: 'ask' });
  cleanup.push(async () => { await service.close(); await runtime.shutdown(); await repos.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    repos, agents, parent, calls, stopped, deliveries, notifications,
    holdStart(action: () => Promise<void>) { beforeStart = action; },
    get service() { return service; }, get runtime() { return runtime; },
    deny() { allowed = false; }, allow() { allowed = true; }, denyAgent(id: string) { deniedAgents.add(id); }, holdSubmit(action: () => Promise<void>) { beforeSubmit = action; },
    async recreateService() { await service.close(); service = makeService(); },
    async reboot() { await service.close(); await runtime.shutdown(); runtime = makeRuntime(); service = makeService(); await runtime.initialize(agents); },
    create: (custom = plan, key = 'request-1') => service.create(parent.id, { goal: 'Compare evidence', plan: custom, idempotencyKey: key }, 'ou_owner'),
    get: (id: string) => service.get(parent.id, id, 'ou_owner'),
    async tick() { await service.tick(); await new Promise(resolve => setTimeout(resolve, 10)); },
    async finish(call: Call, text: string, failed = false) {
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

describe('WorkItemService with real Runtime and SQLite', () => {
  it('runs independent branches concurrently and synthesizes full frozen results exactly once', async () => {
    const f = await fixture(); const item = await f.create();
    await f.tick(); await eventually(async () => f.calls.length === 2);
    expect(new Set(f.calls.map(call => call.sessionId)).size).toBe(2);
    for (const call of f.calls) expect(await f.service.parentForSession(call.sessionId)).toMatchObject({ parentSessionId: f.parent.id, actorId: 'ou_owner', workId: item.id });
    await f.finish(f.calls[0]!, 'First result'); await f.finish(f.calls[1]!, 'Second result');
    await f.tick(); await eventually(async () => f.calls.length === 3);
    expect(f.calls[2]!.prompt).toContain('First result'); expect(f.calls[2]!.prompt).toContain('Second result');
    await f.finish(f.calls[2]!, 'Complete comparison'); await f.tick();
    const done = await f.get(item.id);
    expect(done.status).toBe('completed'); expect(done.output).toMatchObject({ text: 'Complete comparison', digest: expect.stringMatching(/^[a-f0-9]{64}$/), stepId: 'join' });
    expect(done.delivery.status).toBe('delivered');
    await f.tick(); expect(f.deliveries).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(done)).not.toContain('ou_owner');
  });

  it('recovers a lost accepted response without sending a second prompt', async () => {
    const f = await fixture(); const dispatch = f.runtime.dispatch.bind(f.runtime);
    vi.spyOn(f.runtime, 'dispatch').mockImplementationOnce(async (...args) => { await dispatch(...args); throw new Error('response lost'); });
    const single = { ...plan, steps: [plan.steps[0]!], outputStepId: 'a' };
    const item = await f.create(single); await f.tick(); await eventually(async () => f.calls.length === 1);
    await f.recreateService(); await f.tick(); expect(f.calls).toHaveLength(1);
    await f.finish(f.calls[0]!, 'Recovered result'); await f.tick();
    expect((await f.get(item.id)).status).toBe('completed');
    expect((await f.repos.tasks.listBySession(f.calls[0]!.sessionId))).toHaveLength(1);
  });

  it('persists cancellation, stops only owned children and rejects late success and joins', async () => {
    const f = await fixture(); const item = await f.create(); const unrelated = await f.runtime.start({ agentId: 'alpha', cwd: f.parent.cwd });
    await f.tick(); await eventually(async () => f.calls.length === 2);
    const current = await f.get(item.id);
    await f.service.cancel(f.parent.id, item.id, current.revision, 'ou_owner');
    expect((await f.get(item.id)).status).toBe('cancelled');
    expect(f.stopped).not.toContain(unrelated.id);
    f.calls[0]!.finish('Late result'); await f.tick();
    expect((await f.get(item.id)).output).toBeUndefined(); expect(f.calls).toHaveLength(2); expect(f.deliveries).not.toHaveBeenCalled();
    await f.reboot(); await f.tick(); expect((await f.get(item.id)).status).toBe('cancelled'); expect(f.calls).toHaveLength(2);
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

  it('only retries the failed branch and preserves succeeded siblings', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 2);
    await f.finish(f.calls[0]!, 'Kept result'); await f.finish(f.calls[1]!, '', true); await f.tick();
    const failed = await f.get(item.id); expect(failed.status).toBe('failed');
    await f.service.retryStep(f.parent.id, item.id, 'b', failed.revision, 'ou_owner'); await f.tick();
    await eventually(async () => f.calls.length === 3);
    expect(f.calls[2]!.prompt).toContain('Research B'); expect((await f.get(item.id)).steps[0]!.attempts).toHaveLength(1);
    await f.finish(f.calls[2]!, 'New result'); await f.tick(); await eventually(async () => f.calls.length === 4);
    expect(f.calls[3]!.prompt).toContain('Kept result'); expect(f.calls[3]!.prompt).toContain('New result');
  });

  it('blocks configuration drift and never falls back to a global owner', async () => {
    const f = await fixture(); const item = await f.create();
    await f.repos.agents.save({ ...f.agents[0]!, model: 'changed' }); await f.tick();
    expect((await f.get(item.id)).status).toBe('blocked'); expect(f.calls).toHaveLength(0);
    await expect(f.service.create(f.parent.id, { goal: 'x', plan, idempotencyKey: 'anonymous' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.service.get(f.parent.id, item.id, 'ou_other')).rejects.toMatchObject({ statusCode: 403 });
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
    await f.tick(); expect((await f.get(item.id)).delivery.status).toBe('delivered'); expect(f.calls).toHaveLength(1); expect(f.deliveries).toHaveBeenCalledTimes(2);
  });
  it('fences an accepted task before driver.send when cancellation wins preparation', async () => {
    const f = await fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); f.holdSubmit(() => gate);
    const item = await f.create({ ...plan, steps: [plan.steps[0]!], outputStepId: 'a' }); await f.tick();
    const current = await f.get(item.id); const attempt = current.steps[0]!.attempts[0]!;
    await eventually(async () => (await f.repos.tasks.listBySession(attempt.sessionId!))[0]?.status === 'running');
    const cancelling = f.service.cancel(f.parent.id, item.id, current.revision, 'ou_owner');
    await eventually(async () => (await f.get(item.id)).status === 'cancelling'); release();
    await cancelling; await f.tick();
    expect(f.calls).toHaveLength(0); expect((await f.get(item.id)).status).toBe('cancelled');
    expect((await f.repos.tasks.listBySession(attempt.sessionId!))[0]?.status).toBe('cancelled');
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
    const failed = await f.get(item.id); expect(failed.status).toBe('failed'); expect(failed.output).toBeUndefined();
    expect(failed.steps[0]!.attempts[0]!.error).toContain('exceeds'); expect(f.deliveries).not.toHaveBeenCalled();
  });

  it('blocks parent source drift and rejects new work on stopped parents', async () => {
    const f = await fixture(); const item = await f.create();
    await f.repos.sessions.save({ ...(await f.repos.sessions.get(f.parent.id))!, sourceId: 'different-group' }); await f.tick();
    expect((await f.get(item.id)).status).toBe('blocked');
    await f.runtime.stop(f.parent.id);
    await expect(f.create(plan, 'stopped')).rejects.toMatchObject({ code: 'WORK_ITEM_PARENT_INACTIVE' });
    expect((await f.get(item.id)).id).toBe(item.id);
  });

  it('caps a work at three active branches and requires a trusted stable-session entry', async () => {
    const f = await fixture();
    const branches = ['a', 'b', 'c', 'd'].map(id => ({ ...plan.steps[0]!, id }));
    const item = await f.create({ title: 'Bounded', steps: [...branches, { ...plan.steps[2]!, dependsOn: branches.map(step => step.id) }], outputStepId: 'join' });
    await f.tick(); await eventually(async () => f.calls.length === 3); await f.tick(); expect(f.calls).toHaveLength(3);
    await f.finish(f.calls[0]!, 'Done'); await f.tick(); await eventually(async () => f.calls.length === 4);
    expect((await f.get(item.id)).steps.filter(step => step.status === 'running')).toHaveLength(3);
    await expect(f.runtime.start({ agentId: 'alpha', source: 'work_item', sourceId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_WORK_SESSION' });
  });

  it.each(['stop', 'archive', 'revoke'] as const)('stops active children when parent authority becomes %s', async mode => {
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 2);
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
    await eventually(async () => (await f.repos.sessions.get((await f.get(item.id)).steps[0]!.attempts[0]!.sessionId!))?.state === 'failed');
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
    // Even a terminal task and persisted stopped session do not prove the
    // resource is gone: the concrete driver may have refused adoption/kill.
    const task = (await f.repos.tasks.listBySession(attempt.sessionId!))[0]!;
    await f.repos.tasks.save({ ...task, status: 'cancelled' });
    const cancelled = await f.service.cancel(f.parent.id, item.id, blocked.revision, 'ou_owner');
    expect(cancelled.status).toBe('blocked'); expect(cancelled.steps[0]!.status).toBe('blocked');
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
    const read = vi.spyOn(f.repos.config, 'get'); const write = vi.spyOn(f.repos.config, 'compareAndSet');
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
