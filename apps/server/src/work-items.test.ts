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
  let allowed = true; let gated = false; let service: WorkItemService; let runtime: DutydeckRuntime;
  const deliveries = vi.fn(async (_item: WorkItem) => {});
  const notifications = vi.fn(async (_item: WorkItem, _actorId: string) => {});
  const makeRuntime = () => new DutydeckRuntime(repos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
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
        send: (prompt: string) => new Promise<void>(resolve => {
          current = () => { onEvent({ type: 'completed', data: { stopReason: 'cancelled' } }); resolve(); };
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
    repos, agents, parent, calls, stopped, deliveries, notifications,
    holdStart(action: () => Promise<void>) { beforeStart = action; },
    get service() { return service; }, get runtime() { return runtime; },
    deny() { allowed = false; }, allow() { allowed = true; }, denyAgent(id: string) { deniedAgents.add(id); }, holdSubmit(action: () => Promise<void>) { beforeSubmit = action; },
    gate(on = true) { gated = on; },
    async recreateService() { await service.close(); service = makeService(); },
    async reboot() { await service.close(); await runtime.shutdown(); runtime = makeRuntime(); service = makeService(); await runtime.initialize(agents); },
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
    await f.tick(); await eventually(async () => f.calls.length === 2);
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

  it('denies a foreign actor or App when stopping an owned child after execution revocation', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick();
    await eventually(async () => f.calls.length === 2);
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
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 2);
    await f.finish(f.calls[0]!, 'Kept result'); await f.finish(f.calls[1]!, '', true); await f.tick();
    const failed = await f.get(item.id); expect(failed.status).toBe('failed');
    await f.service.retryStep(f.parent.id, item.id, 'b', failed.revision, 'ou_owner'); await f.tick();
    await eventually(async () => f.calls.length === 3);
    expect(f.calls[2]!.prompt).toContain('Research B'); expect((await f.get(item.id)).steps[0]!.attempts).toHaveLength(1);
    await f.finish(f.calls[2]!, 'New result'); await f.tick(); await eventually(async () => f.calls.length === 4);
    expect(f.calls[3]!.prompt).toContain('Kept result'); expect(f.calls[3]!.prompt).toContain('New result');
  });

  it('stops each child once its result is saved and retries in a fresh child', async () => {
    const f = await fixture(); const item = await f.create(); await f.tick(); await eventually(async () => f.calls.length === 2);
    const [kept, failed] = f.calls.map(call => call.sessionId);
    await f.finish(f.calls[0]!, 'Kept result'); await f.finish(f.calls[1]!, '', true); await f.tick();
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
  await f.tick(); await eventually(async () => f.calls.length === 2);
  await f.finish(f.calls[0]!, 'Context evidence'); await f.finish(f.calls[1]!, 'Implementation version 1');
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
    await f.tick(); await eventually(async () => f.calls.length === 2);
    const firstWorkspace = (await f.runtime.getWorkspace(f.calls[1]!.sessionId))!;
    expect(firstWorkspace.mode).toBe('worktree'); expect(firstWorkspace.cwd).not.toBe(f.parent.cwd);
    await writeFile(join(firstWorkspace.cwd, 'feature.txt'), 'version one');
    await f.finish(f.calls[0]!, 'Context evidence'); await f.finish(f.calls[1]!, 'Implementation version 1');
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
