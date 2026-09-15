import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, canonicalExecutionJson, RuntimeError, type AgentDriver, type ExecutionActor, type NormalizedDriverEvent, type TaskAdmissionV1, type TaskRequestV1, type WorkItem, type WorkPlan } from '@dutydeck/shared';
import { createRepositories, executionTaskId } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { WorkItemService } from './work-items.js';
import { readAttemptResult, TASK_RESULT_OUTPUT_BYTES } from './task-results.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Condition did not converge');
}
/** WorkItem 图推进是显式 tick；轮询期间重复 tick 才能观察到 Runtime 异步结算。 */
async function eventuallyItem(f: { tick: () => Promise<void> }, check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { await f.tick(); if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Condition did not converge');
}
const single: WorkPlan = { title: 'Research', steps: [{ id: 'a', title: 'Research A', kind: 'agent', agentId: 'native', instruction: 'Research A', dependsOn: [] }], outputStepId: 'a' };

interface Hooks {
  beforeSubmit?: () => Promise<void>;
  prepare?: (prompt: string) => void | Promise<void>;
  startGate?: Promise<void>;
  emitOutput?: (emit: (event: NormalizedDriverEvent) => void) => void;
  /** 在真实 accept 之后、第一次 claimNext 之前，用旁路连接把持久 input 降级为缺 executionOptions 的 V1。 */
  downgradeInputBeforeClaim?: boolean;
}

async function fixture(mode: 'jsonl' | 'factory' = 'jsonl', hooks: Hooks = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workitem-ledger-integration-'));
  const database = join(directory, 'state.db');
  const sentLog = join(directory, 'sent.jsonl');
  let repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  if (hooks.downgradeInputBeforeClaim) {
    // 真实命令链上的精确旁路：claimNext 开启自己的 BEGIN IMMEDIATE 前先改写持久 input。
    const originalBind = repos.execution.bind.bind(repos.execution);
    vi.spyOn(repos.execution, 'bind').mockImplementation(claim => {
      const bound = originalBind(claim);
      const originalClaimNext = bound.claimNext.bind(bound);
      let downgraded = false;
      bound.claimNext = fence => {
        if (!downgraded) {
          downgraded = true;
          const db = new Database(database);
          try {
            const row = db.prepare('SELECT task_id, accepted_json FROM task_requests WHERE namespace=?').get('work_item') as { task_id: string; accepted_json: string } | undefined;
            if (row) {
              const parsed = JSON.parse(row.accepted_json) as { prompt: string; executionContext: unknown; contentSources: unknown[] };
              const v1 = { version: 1 as const, prompt: parsed.prompt, executionContext: parsed.executionContext, contentSources: parsed.contentSources ?? [] };
              const digest = createHash('sha256').update(canonicalExecutionJson(v1)).digest('hex');
              db.prepare('UPDATE task_requests SET accepted_json=? WHERE task_id=?').run(JSON.stringify({ ...v1, digest }), row.task_id);
            }
          } finally { db.close(); }
        }
        return originalClaimNext(fence);
      };
      return bound;
    });
  }
  const prepareCalls: string[] = [];
  const stopped: string[] = [];
  const deliveries = vi.fn(async (_item: WorkItem) => {});
  let service!: WorkItemService; let runtime!: DutydeckRuntime;
  const nativeAgent = agentConfigSchema.parse({
    id: 'native', name: 'Native fixture', protocol: 'jsonl', command: process.execPath,
    args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
    cwd: directory, env: { turn_agent_submission_log: sentLog },
    permissionMode: 'ask', timeout: 15, capabilities: { pause: false, resume: true }
  });
  const factoryAgent = agentConfigSchema.parse({ id: 'native', name: 'Factory fixture', command: 'fake', protocol: 'jsonl', cwd: directory, permissionMode: 'ask' });
  const makeRuntime = (targetRepos = repos) => new DutydeckRuntime(targetRepos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    probe: () => ({ available: true, protocol: 'jsonl', pause: false, resume: true }),
    authorizeExecution: async (id, actor) => { await service.authorizeExecution(id, actor); },
    sessionPrompt: async (session, prompt) => { if (session.source === 'work_item') await hooks.beforeSubmit?.(); return prompt; },
    prepareTaskPrompt: async (_session, prompt) => { prepareCalls.push(prompt); await hooks.prepare?.(prompt); return { agentPrompt: 'frozen:' + prompt }; },
    authorizeTask: (session, task, phase) => service.authorizeTask(session, task, phase),
    ...(mode === 'factory' ? { driverFactory: (_agent, _protocol, onEvent, _onExit, sessionId): AgentDriver => {
      let killStartup: ((error: Error) => void) | undefined;
      return {
        // startGate 只栅栏 WorkItem 子会话；父 lark 会话必须照常启动。
        start: async () => { if (hooks.startGate && sessionId.startsWith('ses_work_')) await Promise.race([hooks.startGate, new Promise<void>((_resolve, reject) => { killStartup = reject; })]); },
        resume: async () => {}, interrupt: async () => {},
        stop: async () => { stopped.push(sessionId); killStartup?.(new Error('stopped during startup')); },
        isStopped: async () => stopped.includes(sessionId),
        send: async () => { hooks.emitOutput?.(onEvent); onEvent({ type: 'completed', data: { stopReason: 'end_turn' } }); }
      };
    } } : {})
  });
  const makeService = (targetRepos = repos, targetRuntime = runtime) => new WorkItemService({ repositories: targetRepos, runtime: targetRuntime, authorize: async (_id, actor) => actor === 'ou_owner' || actor === 'installation_owner', deliver: deliveries });
  runtime = makeRuntime(); service = makeService();
  await runtime.initialize([mode === 'jsonl' ? nativeAgent : factoryAgent]);
  const parent = await runtime.start({ agentId: 'native', cwd: directory, source: 'lark', sourceId: 'cli_app:ou_owner:root', permissionMode: 'ask' });
  cleanup.push(async () => { await service.close(); await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const create = (key = 'request-1') => service.create(parent.id, { goal: 'Compare evidence', plan: single, idempotencyKey: key }, 'ou_owner');
  return {
    directory, database,
    get repos() { return repos; },
    get runtime() { return runtime; },
    get service() { return service; },
    createSecondService: () => makeService(repos, runtime),
    parent, deliveries, prepareCalls, stopped, sentLog,
    create, get: (id: string) => service.get(parent.id, id, 'ou_owner'),
    cancel: (id: string, revision: number, actor = 'ou_owner') => service.cancel(parent.id, id, revision, actor),
    async tick() { await service.tick(); await new Promise(resolve => setTimeout(resolve, 10)); },
    async recreateService() { await service.close(); service = makeService(); return service; },
    /** 真实重开：旧进程连同其挂起 launch 一起死亡，新 Runtime 重新绑定账本并恢复队列。 */
    async reboot() {
      await service.close(); await runtime.shutdown();
      runtime = makeRuntime(); service = makeService(); await runtime.initialize([mode === 'jsonl' ? nativeAgent : factoryAgent]);
      return service;
    },
    /** 真实 SQLite close/reopen：结束旧 Runtime/Service，关闭 SQLite 连接，完全重新开库初始化。 */
    async closeAndReopenDatabase() {
      await service.close();
      await runtime.shutdown();
      repos.close();
      repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
      runtime = makeRuntime(repos);
      service = makeService(repos, runtime);
      await runtime.initialize([mode === 'jsonl' ? nativeAgent : factoryAgent]);
      return { repos, runtime, service };
    },
    rawWork: async (id: string) => JSON.parse((await repos.config.get('work_item:' + id))!) as {
      item: WorkItem;
      actorId: string;
      actor?: ExecutionActor;
      cancellationActor?: ExecutionActor;
      admissions?: Record<string, TaskAdmissionV1>;
    }
  };
}

describe('WorkItem ledger integration with real SQLite and local drivers', () => {
  it('runs a real JSONL subprocess child, freezes the result and never exposes the private admission', async () => {
    const f = await fixture('jsonl');
    const item = await f.create();
    await eventuallyItem(f, async () => (await f.get(item.id)).status === 'completed');
    const done = await f.get(item.id);
    expect(done.output).toMatchObject({ stepId: 'a', digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const attempt = done.steps[0]!.attempts[0]!;
    expect(attempt.result).toMatchObject({ version: 1, outcome: 'completed', taskId: attempt.taskId, attemptId: attempt.runtimeAttemptId });
    expect(attempt.result!.throughSequence).toBeGreaterThan(0);
    expect(attempt.resultBoundary).toBe('verified');
    // 真实子进程确实收到一次冻结提示。
    const sent = (await readFile(f.sentLog, 'utf8')).trim().split('\n');
    expect(sent).toHaveLength(1); expect(sent[0]).toContain('frozen:');
    // 私有 admission/actor 材料不进入任何公开投影。
    const publicJson = JSON.stringify(done);
    expect(publicJson).not.toContain('sourcePayload'); expect(publicJson).not.toContain('admission');
    expect(publicJson).not.toContain('cli_app'); expect(publicJson).not.toContain('ou_owner');
    // 内部记录确有 admission，且 canonical task 已被真实接受。
    const stored = await f.rawWork(item.id);
    expect(stored.actor).toMatchObject({ kind: 'channel', appId: 'cli_app' });
    const taskId = stored.admissions![attempt.id]!.taskId;
    expect(f.repos.execution.getAcceptedTask(taskId)!.replayValidation).toBe('complete');
    expect(taskId).toBe(executionTaskId('work_item', attempt.sessionId!, attempt.id));
    expect(f.deliveries).toHaveBeenCalledTimes(1);
  });

  it('completes the same admission after a lost dispatch response and SQLite close/reopen without re-reading material or re-sending', async () => {
    const f = await fixture('jsonl');
    const dispatch = f.runtime.dispatch.bind(f.runtime);
    let dispatchAccepted = false;
    // 真实 cut point：Task 已在 SQLite 中持久接受。
    // 在来源收到回执并把 attempt.status 改为 accepted 之前，等待底层驱动事件正常入库以避免 shutdown 打断任务，
    // 然后关闭 service 并抛出异常，使 catch 因 this.closed === true 不再把 accepted 回写
    vi.spyOn(f.runtime, 'dispatch').mockImplementationOnce(async (...args) => {
      const result = await dispatch(...(args as Parameters<typeof dispatch>));
      dispatchAccepted = true;
      while (f.repos.execution.getTaskExecution(result.id)?.currentAttempt?.state !== 'settled') {
        await new Promise(r => setTimeout(r, 20));
      }
      await f.service.close();
      throw new Error('response lost: network partition before source status write');
    });
    const item = await f.create();
    // 第一次 tick 触发 launch，dispatch 提交落库后来源进程关闭抛错退出，未在当前 tick 回写 accepted
    await f.tick();
    expect(dispatchAccepted).toBe(true);

    // 重开前直接读取原 SQLite 底层原始数据，断言故障窗口真实存在：
    // admission 已经固定，但 attempt.status 依然停留在 preparing（尚未写回 accepted）
    const dbBeforeClose = new Database(f.database);
    try {
      const raw = dbBeforeClose.prepare('SELECT value FROM configs WHERE key = ?').get('work_item:' + item.id) as { value: string };
      const stored = JSON.parse(raw.value) as { item: WorkItem; admissions: Record<string, TaskAdmissionV1> };
      const att = stored.item.steps[0]!.attempts[0]!;
      expect(stored.admissions[att.id]).toBeDefined(); // admission 已固定
      expect(att.status).toBe('preparing'); // accepted 状态尚未持久写回！
      expect(att.taskId).toBe(stored.admissions[att.id]!.taskId);
      expect(att.runtimeAttemptId).toBeUndefined();
      expect(att.result).toBeUndefined();
      expect(f.repos.execution.getTaskExecution(att.taskId!)!.currentAttempt!.state).toBe('settled');
      expect(stored.item.status).toBe('running');
    } finally { dbBeforeClose.close(); }

    // 真实 SQLite 关闭并重新打开：完全关闭 SQLite 连接与 Runtime，重新开库初始化
    await f.closeAndReopenDatabase();

    // 重新打开后 tick：来源通过 execution.getAcceptedTask 找到已持久事实，补齐同一映射并完成
    await eventuallyItem(f, async () => (await f.get(item.id)).status === 'completed');
    const sent = (await readFile(f.sentLog, 'utf8')).trim().split('\n');
    expect(sent).toHaveLength(1); // 供应商只收到一次，没有重发
    expect(f.prepareCalls).toHaveLength(1); // 材料/Skill 准备只发生一次
    const done = await f.get(item.id);
    expect(done.steps[0]!.attempts).toHaveLength(1);
    expect(done.steps[0]!.attempts[0]!.result).toMatchObject({ outcome: 'completed' });
    expect(await f.repos.tasks.listBySession(done.steps[0]!.attempts[0]!.sessionId!)).toHaveLength(1); // 不造第二份 Task
    expect(f.deliveries).toHaveBeenCalledTimes(1);
  });

  it('lets two competing services start from the same unchosen admission raw, winning only once via Config CAS', async () => {
    const f = await fixture('jsonl');
    const serviceA = f.service;
    const serviceB = f.createSecondService();
    cleanup.push(() => serviceB.close());
    const item = await f.create();

    // 取出未选择 admission 的原始记录（step 处于 pending，admissions 为空）
    const key = 'work_item:' + item.id;
    const baseRaw = await f.repos.config.get(key);
    expect(baseRaw).toBeTruthy();
    const baseState = JSON.parse(baseRaw!) as { item: WorkItem };
    expect(baseState.item.steps[0]!.attempts).toHaveLength(0);

    // Only hold the actual write that chooses the first admission, after both services read the same raw.
    const attemptId = `${item.id}:a:1`;
    const casResults: boolean[] = [];
    let winnerEntered!: () => void;
    let loserEntered!: () => void;
    let winnerCommitted!: () => void;
    let releaseWinner!: () => void;
    let releaseLoser!: () => void;
    const winnerReady = new Promise<void>(resolve => { winnerEntered = resolve; });
    const loserReady = new Promise<void>(resolve => { loserEntered = resolve; });
    const committed = new Promise<void>(resolve => { winnerCommitted = resolve; });
    const winnerGate = new Promise<void>(resolve => { releaseWinner = resolve; });
    const loserGate = new Promise<void>(resolve => { releaseLoser = resolve; });
    let tickA: Promise<void> | undefined;
    let tickB: Promise<void> | undefined;
    cleanup.push(async () => {
      releaseWinner(); releaseLoser();
      await Promise.allSettled([tickA, tickB]);
    });
    const originalCas = f.repos.config.compareAndSet!.bind(f.repos.config);
    if (!f.repos.config.compareAndSet) throw new Error('compareAndSet required');
    const configWithCas = f.repos.config as Required<Pick<typeof f.repos.config, 'compareAndSet'>> & typeof f.repos.config;
    let contenders = 0;
    vi.spyOn(configWithCas, 'compareAndSet').mockImplementation(async (casKey, expected, value) => {
      if (casKey !== key || expected !== baseRaw) return originalCas(casKey, expected, value);
      const candidate = JSON.parse(value) as { admissions?: Record<string, TaskAdmissionV1> };
      expect(candidate.admissions?.[attemptId]?.kind).toBe('canonical');
      const position = contenders++;
      expect(position).toBeLessThan(2);
      if (position === 0) { winnerEntered(); await winnerGate; }
      else { loserEntered(); await loserGate; }
      const won = await originalCas(casKey, expected, value);
      casResults.push(won);
      if (position === 0) winnerCommitted();
      return won;
    });
    tickA = serviceA.tick();
    await winnerReady;
    tickB = serviceB.tick();
    await loserReady;
    releaseWinner();
    await committed;
    const chosenTaskId = (await f.rawWork(item.id)).admissions![attemptId]!.taskId;
    releaseLoser();
    await Promise.all([tickA, tickB]);
    expect(casResults).toEqual([true, false]);
    // The losing service drives the committed mapping on its next read.
    await eventuallyItem({ tick: () => serviceB.tick() }, async () => (await f.get(item.id)).status === 'completed');
    const done = await f.get(item.id);
    const stored = await f.rawWork(item.id);
    expect(Object.keys(stored.admissions ?? {})).toHaveLength(1);
    expect(stored.admissions![attemptId]!.taskId).toBe(chosenTaskId);
    expect(done.steps[0]!.attempts[0]!.taskId).toBe(chosenTaskId);
    expect(await f.repos.tasks.listBySession(done.steps[0]!.attempts[0]!.sessionId!)).toHaveLength(1);
    const sent = (await readFile(f.sentLog, 'utf8')).trim().split('\n');
    expect(sent).toHaveLength(1); // 真实子进程严格只收到一次 prompt
  });

  it('keeps an already accepted legacy task with V2 options as legacy_partial and completes without minting a second task', async () => {
    // 正向兼容路径：旧来源记录未存 admission，但引用的已接受任务具备完整 V2 输入
    const f = await fixture('jsonl');
    const attemptKey = 'legacy-v2-attempt-1';
    const sessionId = 'ses_work_' + createHash('sha256').update(attemptKey).digest('hex');

    // 1) 真实创建 WorkItem 子 Session
    const child = await f.runtime.startWorkItemSession(
      { agentId: 'native', cwd: f.directory, permissionMode: 'ask', source: 'work_item', sourceId: attemptKey },
      sessionId, async () => {}
    );
    const prompt = 'Goal: legacy-v2\n\nStep: Research A\nResearch A\n\nReturn the complete generated result for this step.';
    const request: TaskRequestV1 = {
      version: 1, namespace: 'work_item', sessionId, key: attemptKey,
      actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' }, prompt, mode: 'queue', skills: [],
      options: { permissionMode: 'ask' }, sources: [], sourcePayload: { agentPrompt: 'frozen:' + prompt, skills: [] }
    };

    // 2) 经独立绑定落一个具备完整 V2 输入的已接受 queued Task
    await f.runtime.shutdown();
    const seedClaim = f.repos.control.attachRuntime('legacy-v2-seed');
    try {
      const bound = f.repos.execution.bind(seedClaim);
      const content = { version: 2 as const, prompt, executionContext: { agentPrompt: 'frozen:' + prompt, actorId: 'ou_owner' }, contentSources: [], executionOptions: { permissionMode: 'ask' as const } };
      const input = { ...content, digest: createHash('sha256').update(canonicalExecutionJson(content)).digest('hex') };
      bound.acceptTask({ sessionId, runId: child.runId }, request, input, 'back');
    } finally { seedClaim.release(); }
    const taskId = executionTaskId('work_item', sessionId, attemptKey);

    // 3) 写入旧版来源记录：引用已接受的 taskId，但没有 admission 字段
    const dbParent = await f.repos.sessions.get(f.parent.id);
    if (!dbParent) throw new Error('parent session not found');
    const agent = await f.repos.agents.get('native');
    if (!agent) throw new Error('agent not found');
    const fp = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const timestamp = new Date().toISOString();
    const legacyRecord = {
      item: {
        id: 'work_legacy_v2', parentSessionId: f.parent.id, title: 'Legacy V2 Work', goal: 'legacy-v2', revision: 1, status: 'running',
        plan: single, steps: [{ id: 'a', status: 'running', attempts: [{ id: attemptKey, number: 1, sessionId, taskId, status: 'preparing', createdAt: timestamp, updatedAt: timestamp }] }],
        createdAt: timestamp, updatedAt: timestamp, delivery: { status: 'not_requested', attempts: 0 }
      },
      actorId: 'ou_owner', actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' },
      inputHash: 'legacy-v2', cwd: f.directory,
      parentFingerprint: fp({ agentId: dbParent.agentId, cwd: dbParent.cwd, permissionMode: dbParent.permissionMode, model: dbParent.model, reasoningEffort: dbParent.reasoningEffort, systemPrompt: dbParent.systemPrompt, source: dbParent.source, sourceId: dbParent.sourceId }),
      agents: { native: { fingerprint: fp(agent), permissionMode: 'ask' } }, stoppedAttempts: []
    };
    await f.repos.config.set('work_item:work_legacy_v2', JSON.stringify(legacyRecord));

    // 4) 重开新 Runtime 并驱动完成
    await f.reboot();
    await eventuallyItem(f, async () => (await f.get('work_legacy_v2')).status === 'completed');
    const stored = await f.rawWork('work_legacy_v2');
    const admission = Object.values(stored.admissions!)[0] as TaskAdmissionV1;
    expect(admission.kind).toBe('legacy_partial');
    expect(admission.taskIdVersion).toBe('v1');
    expect(admission.taskId).toBe(taskId); // 沿用原 ID，不造 canonical 第二份
    expect(await f.repos.tasks.listBySession(sessionId)).toHaveLength(1);
    const done = await f.get('work_legacy_v2');
    expect(done.steps[0]!.attempts).toHaveLength(1);
    expect(done.steps[0]!.attempts[0]!.result).toMatchObject({ taskId, outcome: 'completed' });
  });

  it('persists admission_conflict when the task key already carries a different request', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const f = await fixture('factory', { startGate });
    const item = await f.create();
    void f.tick();
    // 等子 Session 已真实创建（driver.start 仍挂起），此时让同 key lookup 报异载荷冲突
    await eventually(async () => {
      const sessionId = (await f.get(item.id)).steps[0]?.attempts[0]?.sessionId;
      return !!sessionId && (await f.repos.sessions.get(sessionId)) !== undefined;
    });
    vi.spyOn(f.runtime, 'lookupAcceptedTask').mockImplementation(() => { throw new RuntimeError('TASK_IDEMPOTENCY_CONFLICT', 'same key carries a different request', 409); });
    releaseStart();
    await eventuallyItem(f, async () => (await f.get(item.id)).status === 'blocked');
    const blocked = await f.get(item.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.steps[0]!.attempts[0]!.blockReason).toBe('admission_conflict');
  });

  it('blocks V1 input that cannot be frozen before submission, and never delivers it', async () => {
    const f = await fixture('jsonl', { downgradeInputBeforeClaim: true });
    const item = await f.create();
    await eventuallyItem(f, async () => (await f.get(item.id)).status === 'blocked');
    const blocked = await f.get(item.id);
    expect(blocked.status).toBe('blocked');
    expect(blocked.steps[0]!.attempts[0]!.blockReason).toBe('legacy_input_unresolved');
    expect(blocked.output).toBeUndefined(); expect(f.deliveries).not.toHaveBeenCalled();
    expect(f.prepareCalls).toHaveLength(1);
    expect(await f.repos.tasks.listBySession(blocked.steps[0]!.attempts[0]!.sessionId!)).toHaveLength(1);
    // 真实子进程从未收到 send：输入不可核验时零提交
    await expect(readFile(f.sentLog, 'utf8')).rejects.toBeDefined();
  });

  it('preserves historical legacy task ID after upgradeLegacy and blocks on unverifiable V1 input without minting a second task', async () => {
    // 反向阻塞路径：真实 legacy authority 历史数据库离线升级，旧输入缺少 executionOptions 保持 blocked
    const dir = await mkdtemp(join(tmpdir(), 'workitem-legacy-upgrade-'));
    cleanup.push(async () => rm(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'legacy.db');
    const legacyRepos = createRepositories(dbPath, { newDatabaseAuthority: 'legacy' });
    const attemptKey = 'legacy-task-attempt-1';
    const childSessionId = 'ses_work_' + createHash('sha256').update(attemptKey).digest('hex');
    const parentSessionId = 'parent_legacy_ses';
    const timeStr = new Date().toISOString();

    // 在 legacy 数据库中写入历史 parent session 与 child session
    const parentSession = { id: parentSessionId, runId: 'parent-run', agentId: 'native', cwd: dir, state: 'idle' as const, permissionMode: 'ask' as const, source: 'lark', sourceId: 'cli_app:ou_owner:root', protocol: 'jsonl', createdAt: timeStr, updatedAt: timeStr };
    const childSession = { id: childSessionId, runId: 'child-run', agentId: 'native', cwd: dir, state: 'created' as const, permissionMode: 'ask' as const, source: 'work_item', sourceId: attemptKey, protocol: 'jsonl', createdAt: timeStr, updatedAt: timeStr };
    const db = new Database(dbPath);
    try {
      db.prepare("INSERT INTO sessions (id, run_id, agent_id, cwd, state, permission_mode, source, source_id, protocol, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(parentSession.id, parentSession.runId, parentSession.agentId, parentSession.cwd, parentSession.state, parentSession.permissionMode, parentSession.source, parentSession.sourceId, parentSession.protocol, timeStr, timeStr);
      db.prepare("INSERT INTO sessions (id, run_id, agent_id, cwd, state, permission_mode, source, source_id, protocol, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(childSession.id, childSession.runId, childSession.agentId, childSession.cwd, childSession.state, childSession.permissionMode, childSession.source, childSession.sourceId, childSession.protocol, timeStr, timeStr);
      // 写入旧哈希 Task ID 与缺少 executionOptions 的历史 V1 输入
      const legacyTaskId = 'task_' + createHash('sha256').update(`${childSessionId}\0${attemptKey}`).digest('hex');
      db.prepare("INSERT INTO tasks (id, session_id, prompt, status, execution_context, revision, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, 1, ?, ?)").run(legacyTaskId, childSessionId, 'legacy prompt', JSON.stringify({ agentPrompt: 'legacy prompt', actorId: 'ou_owner' }), timeStr, timeStr);
    } finally { db.close(); }

    // 执行真实离线升级：upgradeLegacy
    legacyRepos.execution.upgradeLegacy();
    expect(legacyRepos.execution.authority()).toBe('ledger_v1');
    const legacyTaskId = 'task_' + createHash('sha256').update(`${childSessionId}\0${attemptKey}`).digest('hex');
    const upgradedTask = legacyRepos.execution.getAcceptedTask(legacyTaskId);
    expect(upgradedTask).toBeDefined();
    expect(upgradedTask!.task.id).toBe(legacyTaskId); // 必须保留原 ID
    expect(upgradedTask!.task.digestVersion).toBe('legacy_unverifiable');
    expect(upgradedTask!.replayValidation).toBe('legacy_partial');

    // 写入历史来源记录：引用 legacyTaskId，没有 admission
    const fp = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const agent = agentConfigSchema.parse({ id: 'native', name: 'Native fixture', command: process.execPath, protocol: 'jsonl', cwd: dir, permissionMode: 'ask' });
    await legacyRepos.agents.save(agent);
    const dbParent = await legacyRepos.sessions.get(parentSessionId);
    if (!dbParent) throw new Error('parent session not found');
    const legacyRecord = {
      item: {
        id: 'work_legacy_1', parentSessionId, title: 'Legacy Work', goal: 'legacy goal', revision: 1, status: 'running',
        plan: single, steps: [{ id: 'a', status: 'running', attempts: [{ id: attemptKey, number: 1, sessionId: childSessionId, taskId: legacyTaskId, status: 'preparing', createdAt: timeStr, updatedAt: timeStr }] }],
        createdAt: timeStr, updatedAt: timeStr, delivery: { status: 'not_requested', attempts: 0 }
      },
      actorId: 'ou_owner', actor: { kind: 'channel', id: 'ou_owner', appId: 'cli_app' },
      inputHash: 'legacy', cwd: dir,
      parentFingerprint: fp({ agentId: dbParent.agentId, cwd: dbParent.cwd, permissionMode: dbParent.permissionMode, model: dbParent.model, reasoningEffort: dbParent.reasoningEffort, systemPrompt: dbParent.systemPrompt, source: dbParent.source, sourceId: dbParent.sourceId }),
      agents: { native: { fingerprint: fp(agent), permissionMode: 'ask' } }, stoppedAttempts: []
    };
    await legacyRepos.config.set('work_item:work_legacy_1', JSON.stringify(legacyRecord));

    // 启动 Runtime 与 WorkItemService，观察旧来源尝试
    const runtime = new DutydeckRuntime(legacyRepos, {
      workspaceRoot: join(dir, 'workspaces'), cleanupIntervalMs: 0,
      probe: () => ({ available: true, protocol: 'jsonl', pause: false, resume: true })
    });
    const service = new WorkItemService({ repositories: legacyRepos, runtime, authorize: async () => true });
    cleanup.push(async () => { await service.close(); await runtime.shutdown(); legacyRepos.close(); });
    await runtime.initialize([agent]);
    await service.tick();

    // 来源 fixAdmission 识别真实接受事实，固定 legacy_partial（沿用 legacyTaskId，绝不生成第二 canonical Task）
    const stored = JSON.parse((await legacyRepos.config.get('work_item:work_legacy_1'))!) as typeof legacyRecord & { admissions?: Record<string, TaskAdmissionV1> };
    const admission = stored.admissions?.[attemptKey];
    expect(admission?.kind).toBe('legacy_partial');
    expect(admission?.taskId).toBe(legacyTaskId);
    expect(admission?.taskIdVersion).toBe('legacy');
    expect(await legacyRepos.tasks.listBySession(childSessionId)).toHaveLength(1); // 数据库中绝不造第二份 canonical task

    // 因旧输入缺少 executionOptions，不可透明执行，来源必须标记为 blocked/legacy_input_unresolved
    const item = await service.get(parentSessionId, 'work_legacy_1', 'ou_owner');
    expect(item.status).toBe('blocked');
    expect(item.steps[0]!.attempts[0]!.blockReason).toBe('legacy_input_unresolved');
  });

  it('retains installation_owner cancellationActor through restart and SQLite reopen when child resource stop is unproven', async () => {
    // 模拟安装者代取消后子驱动尚未证明停止的未决窗口，重开并重新连接真实授权后后续 stop 仍使用原 installation_owner
    let stopProofConfirmed = false;
    const stopWorkItemSessionCalls: Array<{ sessionId: string; actor?: ExecutionActor }> = [];
    const directory = await mkdtemp(join(tmpdir(), 'workitem-cancel-unproven-'));
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    const database = join(directory, 'state.db');
    let repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    const agent = agentConfigSchema.parse({ id: 'native', name: 'Native', command: 'fake', protocol: 'jsonl', cwd: directory, permissionMode: 'ask' });

    let runtime!: DutydeckRuntime;
    let service!: WorkItemService;
    const make = () => {
      let s!: WorkItemService;
      const r = new DutydeckRuntime(repos, {
        workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
        probe: () => ({ available: true, protocol: 'jsonl', pause: false, resume: true }),
        // 挂载真实 Runtime 授权回调，保证授权链完整
        authorizeExecution: async (id: string, actor?: string) => { await s.authorizeExecution(id, actor); },
        authorizeTask: (session, task, phase) => s.authorizeTask(session, task, phase),
        // 作用边界说明：模拟驱动返回一个物理停止未确认的 driver 实例（isStopped 返回 false），模拟未知资源的非安全停止状态
        driverFactory: (_agent, _protocol, _onEvent, _onExit, _sessionId): AgentDriver => ({
          start: async () => {}, resume: async () => {}, interrupt: async () => {},
          stop: async () => {},
          isStopped: async () => stopProofConfirmed,
          send: async () => new Promise<void>(() => {})
        })
      });
      const originalStopWorkItemSession = r.stopWorkItemSession.bind(r);
      r.stopWorkItemSession = async (sid: string, act: ExecutionActor) => {
        stopWorkItemSessionCalls.push({ sessionId: sid, actor: act });
        return originalStopWorkItemSession(sid, act);
      };
      s = new WorkItemService({ repositories: repos, runtime: r, authorize: async () => true });
      return { runtime: r, service: s };
    };

    ({ runtime, service } = make());
    cleanup.push(async () => { await service.close(); await runtime.shutdown(); repos.close(); });
    await runtime.initialize([agent]);
    const parent = await runtime.start({ agentId: 'native', cwd: directory, source: 'lark', sourceId: 'cli_app:ou_owner:root', permissionMode: 'ask' });
    const item = await service.create(parent.id, { goal: 'Unproven cancel test', plan: single, idempotencyKey: 'cancel-unproven' }, 'ou_owner');
    await service.tick();
    await eventually(async () => {
      const current = await service.get(parent.id, item.id, 'ou_owner');
      return current.steps[0]?.status === 'running' && !!current.steps[0]?.attempts[0]?.sessionId;
    });
    const childSessionId = (await service.get(parent.id, item.id, 'ou_owner')).steps[0]!.attempts[0]!.sessionId!;
    const attemptTaskId = (await service.get(parent.id, item.id, 'ou_owner')).steps[0]!.attempts[0]!.taskId!;

    // 安装者代取消：因 isStopped === false，子资源停止无法证明，cancel 返回 blocked 并保存 cancellationActor
    const itemBeforeCancel = await service.get(parent.id, item.id, 'ou_owner');
    const cancelled = await service.cancel(parent.id, item.id, itemBeforeCancel.revision, 'installation_owner');
    expect(cancelled.status).toBe('blocked');
    const rawAfterCancel = JSON.parse((await repos.config.get('work_item:' + item.id))!) as { cancellationActor?: ExecutionActor };
    expect(rawAfterCancel.cancellationActor).toEqual({ kind: 'installation_owner', id: 'installation_owner' });

    // 验证关键前提：即使 Task 在数据库中已被更新为终态（cancelled），终态 Task 仍不能代替物理停止证明
    const db = new Database(database);
    try {
      db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(attemptTaskId);
    } finally { db.close(); }

    // 实际关闭并重新打开 SQLite 数据库连接
    await service.close();
    await runtime.shutdown();
    repos.close();
    repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    ({ runtime, service } = make());
    await runtime.initialize([agent]);

    // 在重新打开的新实例上调用 cancel 继续取消收口
    stopWorkItemSessionCalls.length = 0;
    const itemReopened = await service.get(parent.id, item.id, 'ou_owner');
    const secondCancel = await service.cancel(parent.id, item.id, itemReopened.revision, 'installation_owner');
    // 依然返回 blocked，绝不因为 Task 在数据库中是 terminal 就伪造取消完成
    expect(secondCancel.status).toBe('blocked');
    // 验证新实例调用的 stopWorkItemSession 仍然精确使用 installation_owner，未丢失 App 域或倒退为 unspecified
    expect(stopWorkItemSessionCalls.length).toBeGreaterThan(0);
    expect(stopWorkItemSessionCalls[0]!.actor).toEqual({ kind: 'installation_owner', id: 'installation_owner' });
  });

  it('settles a mapped task cancelled before first claim into blocked without lingering running or fabricating results (F1 regression)', async () => {
    // 永久回归：测试 root probe 1 反例
    const f = await fixture('factory');
    const item = await f.create('first-claim-cancel');
    const attemptKey = `${item.id}:a:1`;
    const childSessionId = 'ses_work_' + createHash('sha256').update(attemptKey).digest('hex');

    // 释放 claim 窗口：关闭旧 Runtime，用直接仓储绑定准备「领取前已取消的映射任务」
    await f.runtime.shutdown();
    const probeClaim = f.repos.control.attachRuntime('probe-f1');
    const bound = f.repos.execution.bind(probeClaim);
    let taskId!: string;
    try {
      const child = {
        id: childSessionId, runId: 'child-run', agentId: 'native', cwd: f.directory,
        state: 'created' as const, permissionMode: 'ask' as const, source: 'work_item', sourceId: attemptKey,
        protocol: 'jsonl' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      bound.createSession(child);
      const fence = { sessionId: child.id, runId: child.runId };
      const request: TaskRequestV1 = {
        version: 1, namespace: 'work_item', key: attemptKey, sessionId: child.id,
        actor: { kind: 'installation_owner', id: 'installation_owner' }, prompt: 'work', mode: 'queue',
        skills: [], options: { permissionMode: 'ask' }, sources: [], sourcePayload: { agentPrompt: 'work' }
      };
      const content = { version: 2 as const, prompt: request.prompt, executionContext: { agentPrompt: request.prompt, actorId: 'installation_owner' }, contentSources: [], executionOptions: { permissionMode: 'ask' as const } };
      const task = bound.acceptTask(fence, request, { ...content, digest: createHash('sha256').update(canonicalExecutionJson(content)).digest('hex') }, 'back').task!;
      taskId = task.id;
      bound.cancelQueued(fence, task.id, task.revision, { decisionId: 'cancel-before-first-claim', action: 'cancel', actor: { kind: 'installation_owner', id: 'installation_owner' }, evidenceRefs: ['actual queued cancellation'], resourceChecks: [] });
      const key = `work_item:${item.id}`;
      const record = JSON.parse((await f.repos.config.get(key))!);
      record.item.steps[0] = { id: 'a', status: 'running', attempts: [{ id: attemptKey, number: 1, sessionId: child.id, taskId: task.id, status: 'accepted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] };
      record.admissions = { [attemptKey]: { version: 1, kind: 'canonical', taskIdVersion: 'v1', taskId: task.id, request } };
      await f.repos.config.set(key, JSON.stringify(record));
    } finally {
      probeClaim.release();
    }

    // 重开新 Runtime 并连接
    await f.reboot();

    // 连续多次 tick，工作项必须从 running 明确收口为 blocked，不长期停留为 running，不造 Result，不交付
    for (let index = 0; index < 3; index++) await f.tick();
    const after = await f.get(item.id);
    expect(f.repos.execution.getTaskExecution(taskId)!.attempts).toHaveLength(0);
    expect(after.steps[0]!.status).toBe('cancelled');
    expect(after.status).toBe('blocked'); // F1 核心断言：不能依然停留在 running
    expect(after.output).toBeUndefined(); // 不造 Result
    expect(f.deliveries).not.toHaveBeenCalled(); // 不交付
  });

  it('verifies and restores missing actor on historical records from parent session (F2-1 regression)', async () => {
    // 永久回归：测试 root probe 2 反例
    const f = await fixture('jsonl');
    const item = await f.create('legacy-actor-restore');
    const key = `work_item:${item.id}`;
    const record = await f.rawWork(item.id);
    delete (record as { actor?: unknown }).actor; // 模拟旧版无 actor 字段记录
    expect(await f.repos.config.compareAndSet!(key, (await f.repos.config.get(key))!, JSON.stringify(record))).toBe(true);

    // tick：来源必须从已验证父 Session 恢复固定 actor，不能阻塞并报 actor domain cannot be verified
    await eventuallyItem(f, async () => (await f.get(item.id)).status === 'completed');
    const done = await f.get(item.id);
    expect(done.status).toBe('completed');
    expect((await f.rawWork(item.id)).actor).toEqual({ kind: 'channel', id: 'ou_owner', appId: 'cli_app' });
  });

  it('blocks historical completed steps without output as legacy_output_unresolved without running downstream (F2-2 regression)', async () => {
    // 永久回归：测试 root probe 4 反例
    const f = await fixture('factory');
    const twoStepPlan: WorkPlan = {
      title: 'Two step plan',
      steps: [
        { id: 'step1', title: 'First step', kind: 'agent', agentId: 'native', instruction: 'Do first', dependsOn: [] },
        { id: 'step2', title: 'Second step', kind: 'agent', agentId: 'native', instruction: 'Do second', dependsOn: ['step1'] }
      ],
      outputStepId: 'step2'
    };
    const parent = await f.repos.sessions.get(f.parent.id);
    if (!parent) throw new Error('parent session not found');

    // 直接创建带有无 output 的 completed step1 记录
    const timeStr = new Date().toISOString();
    const noOutputRecord = {
      item: {
        id: 'work_no_output_upstream', parentSessionId: f.parent.id, title: 'Two step plan', goal: 'no output test', revision: 1, status: 'running',
        plan: twoStepPlan, steps: [
          { id: 'step1', status: 'completed' as const, attempts: [{ id: 'old-completed-attempt', number: 1, status: 'completed' as const, createdAt: timeStr, updatedAt: timeStr }] },
          { id: 'step2', status: 'pending' as const, attempts: [] }
        ],
        createdAt: timeStr, updatedAt: timeStr, delivery: { status: 'not_requested' as const, attempts: 0 }
      },
      actorId: 'ou_owner', actor: { kind: 'channel' as const, id: 'ou_owner', appId: 'cli_app' },
      inputHash: 'hash', cwd: f.directory,
      parentFingerprint: createHash('sha256').update(JSON.stringify({ agentId: parent.agentId, cwd: parent.cwd, permissionMode: parent.permissionMode, model: parent.model, reasoningEffort: parent.reasoningEffort, systemPrompt: parent.systemPrompt, source: parent.source, sourceId: parent.sourceId })).digest('hex'),
      agents: { native: { fingerprint: createHash('sha256').update(JSON.stringify(await f.repos.agents.get('native'))).digest('hex'), permissionMode: 'ask' as const } },
      stoppedAttempts: []
    };
    await f.repos.config.set('work_item:work_no_output_upstream', JSON.stringify(noOutputRecord));

    let downstreamStarts = 0;
    const originalStartWorkItemSession = f.runtime.startWorkItemSession.bind(f.runtime);
    f.runtime.startWorkItemSession = async (...args) => {
      downstreamStarts++;
      return originalStartWorkItemSession(...args);
    };

    // tick：来源必须检测到缺输出边界，将其标记为 blocked/legacy_output_unresolved，绝不启动下游步骤
    await f.tick();
    const after = await f.get('work_no_output_upstream');
    expect(after.status).toBe('blocked');
    expect(after.steps[0]!.status).toBe('blocked');
    expect(after.steps[0]!.attempts[0]!.blockReason).toBe('legacy_output_unresolved');
    expect(after.steps[0]!.attempts[0]!.resultBoundary).toBe('legacy_output_unresolved');
    expect(after.steps[1]!.attempts).toHaveLength(0); // 下游不创建 attempt
    expect(downstreamStarts).toBe(0); // 下游不调用 startWorkItemSession
  });

  it('reads output with split surrogate pairs at exact 524288 bytes successfully (F3 regression)', async () => {
    // 永久回归：测试 root probe 3 反例
    const f = await fixture('factory', {
      emitOutput: emit => {
        emit({ type: 'text', data: { text: 'a'.repeat(TASK_RESULT_OUTPUT_BYTES - 4) } });
        emit({ type: 'text', data: { text: '\ud83d' } });
        emit({ type: 'text', data: { text: '\ude00' } });
      }
    });
    const item = await f.create('surrogate-probe-test');
    void f.tick();
    await eventuallyItem(f, async () => (await f.get(item.id)).status === 'completed');
    const done = await f.get(item.id);
    const result = done.steps[0]!.attempts[0]!.result!;
    expect(Buffer.byteLength(result.output.text, 'utf8')).toBe(TASK_RESULT_OUTPUT_BYTES);
    expect(result.output.digest).toBe(createHash('sha256').update('a'.repeat(TASK_RESULT_OUTPUT_BYTES - 4) + '😀', 'utf8').digest('hex'));
  });

  it('reads output beyond 200 events through the real Runtime ledger before freezing', async () => {
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    const f = await fixture('factory', { startGate, emitOutput: emit => { for (let index = 0; index < 205; index++) emit({ type: 'text', data: { text: '字' } }); } });
    const item = await f.create();
    void f.tick();
    await eventually(async () => Object.keys((await f.rawWork(item.id)).admissions ?? {}).length === 1);
    releaseStart();
    await eventuallyItem(f, async () => (await f.get(item.id)).status === 'completed');
    const result = (await f.get(item.id)).steps[0]!.attempts[0]!.result!;
    expect(result.output.text).toBe('字'.repeat(205));
    expect(result.throughSequence).toBeGreaterThan(200);
    expect(result.output.digest).toBe(createHash('sha256').update('字'.repeat(205), 'utf8').digest('hex'));
  });
});
