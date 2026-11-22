import { defaultDriverProviders } from './driver-providers.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { agentConfigSchema, canonicalExecutionJson, type AttemptResultV1, type Session } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ciProviders, ciStatus, TEST_CI_REMOTE, type StatusMock } from './ci-provider.test-helpers.js';
import { SessionAutomationService } from './session-automation.js';

const run = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function gitRepository(cwd: string) {
  await run('git', ['init', '-q', cwd]);
  await run('git', ['-C', cwd, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', cwd, 'config', 'user.name', 'Test']);
  await run('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'initial']);
  await run('git', ['-C', cwd, 'remote', 'add', 'origin', TEST_CI_REMOTE]);
}

const waitForFile = async (path: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise(r => setTimeout(r, 10));
  }
};

/** 轮询真实持久状态用于收敛（报告如实标注为轮询）；竞争进入/释放一律走文件停点。 */
const waitFor = async (check: () => boolean, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('persistent state did not converge');
    await new Promise(r => setTimeout(r, 10));
  }
};

describe('SessionAutomation real CI recovery across a true SQLite close and a brand-new connection', () => {
  it('accepts a CI continuation, loses the dispatch response, reopens, and delivers once without re-sending or re-reading HEAD/materials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'automation-ci-recovery-'));
    const database = join(directory, 'state.db');
    const sentLog = join(directory, 'sent.jsonl');
    const gateDir = join(directory, 'gate');

    let repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    const gitCwd = join(directory, 'repo');
    await mkdir(gitCwd, { recursive: true });
    await gitRepository(gitCwd);
    const headSha = (await run('git', ['-C', gitCwd, 'rev-parse', 'HEAD'])).stdout.trim();

    const deliveries: Array<{ sessionId: string; result: AttemptResultV1; occurrenceId: string; sourceId: string }> = [];
    let service!: SessionAutomationService;
    let runtime!: DutydeckRuntime;
    let fetchCallsAfterReopen = 0;
    let reopened = false;
    const pipelineStatus = vi.fn(async () => {
      if (reopened) fetchCallsAfterReopen++;
      return ciStatus(headSha, [{ id: 77, conclusion: 'success' }]);
    }) as StatusMock;

    const agent = agentConfigSchema.parse({
      id: 'ci-native', name: 'CI fixture', protocol: 'jsonl', command: process.execPath,
      args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
      cwd: directory,
      env: { turn_agent_submission_log: sentLog, turn_agent_gate_dir: gateDir },
      permissionMode: 'ask', timeout: 20,
      capabilities: { pause: false, resume: true }
    });

    const makeRuntime = (target: typeof repos) => new DutydeckRuntime(target, {
      providers: defaultDriverProviders(),
      workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
      probe: () => ({ available: true, protocol: 'jsonl', pause: false, resume: true }),
      authorizeExecution: async () => {},
      prepareTaskPrompt: async (_s, prompt) => ({ agentPrompt: prompt }),
      authorizeTask: (_session, task, phase) => service.authorizeTask(task, phase)
    });
    const makeService = (target: typeof repos, rt: DutydeckRuntime) => new SessionAutomationService({
      repositories: target,
      runtime: rt,
      authorize: async () => true,
      ciProviders: ciProviders(pipelineStatus),
      clock: () => new Date('2026-09-12T00:00:30Z'),
      deliver: async (sessionId, result, occurrenceId, sourceId) => { deliveries.push({ sessionId, result, occurrenceId, sourceId }); }
    });

    runtime = makeRuntime(repos);
    service = makeService(repos, runtime);
    await runtime.initialize([agent]);
    const parent: Session = await runtime.start({ agentId: 'ci-native', cwd: gitCwd, source: 'lark', sourceId: 'cli_app:oc_owner:group', permissionMode: 'ask' });

    let originalPromise: Promise<void> | undefined;
    cleanup.push(async () => {
      // 夹具收口：观察原 Promise、shutdown、真 close 与原子进程退出。
      if (originalPromise) await originalPromise.catch(() => {});
      await service.close().catch(() => {});
      await runtime.shutdown().catch(() => {});
      repos.close();
      await rm(directory, { recursive: true, force: true });
    });

    const sub = await service.subscribeCi(parent.id, { ttlSeconds: 600 }, 'ou_owner');

    // 接受后响应丢失：真实 dispatch 已 accept 并启动本地 JSONL 子进程（收件一次），
    // 但向 Automation 抛网络分区错误。不能为模拟崩溃篡改产品 close。
    const realDispatch = runtime.dispatchRequest.bind(runtime);
    const dispatchSpy = vi.spyOn(runtime, 'dispatchRequest');
    dispatchSpy.mockImplementation(async (...args: Parameters<typeof runtime.dispatchRequest>) => {
      const result = await realDispatch(...args);
      throw new Error('response lost: network partition after acceptance');
    });

    originalPromise = service.tick();
    // 明确进入停点：agent 已收到唯一一次 prompt（在 gate 前写 submission log）。
    await waitForFile(join(gateDir, 'entered'));
    let sent = (await readFile(sentLog, 'utf8')).trim().split('\n');
    expect(sent).toHaveLength(1);

    // 接受后、Attempt 未完成窗口：接受事实已持久，但尚未结算。
    const taskIdAfterAccept = (await repos.tasks.listBySession(parent.id))[0]!.id;
    expect(repos.execution.getAcceptedTask(taskIdAfterAccept)).toBeDefined();
    const openProjection = repos.execution.getTaskExecution(taskIdAfterAccept)!;
    expect(['queued', 'running']).toContain(openProjection.task.status);
    expect(openProjection.currentAttempt?.state).not.toBe('settled');

    // 释放真实尾声：agent 输出完整结果，Attempt 经真实持久状态收敛为 completed。
    writeFileSync(join(gateDir, 'release'), '1');
    await waitFor(() => repos.execution.getTaskExecution(taskIdAfterAccept)?.currentAttempt?.state === 'settled');

    // === 真关库：service close、runtime shutdown（子进程退出）、连接关闭，再用全新连接/进程重开。 ===
    await service.close();
    await runtime.shutdown();
    repos.close();
    repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    runtime = makeRuntime(repos);
    service = makeService(repos, runtime);
    await runtime.initialize([agent]);
    reopened = true;

    await service.tick();
    await waitFor(() => deliveries.length === 1);

    // Agent 全程只收件一次；重开没有重新 dispatch。
    sent = (await readFile(sentLog, 'utf8')).trim().split('\n');
    expect(sent).toHaveLength(1);
    const tasks = await repos.tasks.listBySession(parent.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(taskIdAfterAccept);
    expect(deliveries[0]!.result.taskId).toBe(taskIdAfterAccept);
    expect(deliveries[0]!.result).toMatchObject({ version: 1, outcome: 'completed' });
    expect(deliveries[0]!.sourceId).toBe(sub.id);
    // 恢复路径不重新读取 CI 提供方的构建材料：重开后零调用（源码取得原结果路径亦不查 HEAD）。
    expect(fetchCallsAfterReopen).toBe(0);
    const stored = JSON.parse((await repos.config.get(`session_automation/ci/${sub.id}`))!)!;
    expect(stored.admission.taskId).toBe(taskIdAfterAccept);
    expect(stored.status).toBe('completed');
    // 双 KV 补同一 binding。
    const bindings = (await repos.config.list!('session_automation/task/')).filter(r => r.key.includes(taskIdAfterAccept));
    expect(bindings).toHaveLength(1);
    expect(JSON.parse(bindings[0]!.value)).toMatchObject({ schemaVersion: 2, kind: 'ci', taskId: taskIdAfterAccept, subscriptionId: sub.id });
  }, 30_000);

  it.each(['active', 'not_started', 'settled'] as const)('checks the real admission and submit boundary before applying an expired TTL: %s', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'automation-ci-expiry-'));
    const database = join(directory, 'state.db');
    const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    const claim = repos.control.attachRuntime('ci-expiry-fixture');
    const bound = repos.execution.bind(claim);
    const sessionId = 'ci_expiry_session';
    const runId = 'ci_expiry_run';
    const source = 'cli_app:oc_owner:group';
    let now = new Date('2026-11-17T00:00:00Z');
    let service!: SessionAutomationService;
    let dispatches = 0;
    let deliveries = 0;
    let taskId = '';
    cleanup.push(async () => { await service.close().catch(() => {}); claim.release(); repos.close(); await rm(directory, { recursive: true, force: true }); });

    await gitRepository(directory);
    const headSha = (await run('git', ['-C', directory, 'rev-parse', 'HEAD'])).stdout.trim();
    const timestamp = now.toISOString();
    bound.createSession({ id: sessionId, runId, agentId: 'fixture', cwd: directory, state: 'idle', source: 'lark', sourceId: source,
      permissionMode: 'ask', createdAt: timestamp, updatedAt: timestamp });
    const pipelineStatus = vi.fn(async () => ciStatus(headSha, [{ id: 88, conclusion: 'success' }])) as StatusMock;
    const providers = ciProviders(pipelineStatus);
    const settle = () => {
      const attempt = repos.execution.getTaskExecution(taskId)!.currentAttempt!;
      const fence = { sessionId, runId, taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision };
      bound.appendEvent(fence, { id: 'ci_expiry_output', type: 'text', data: { role: 'assistant', text: 'Finished CI review' } });
      bound.settleAttempt(fence, 'ci_expiry_settlement', { kind: 'driver_result', submissionId: 'ci_expiry_submission', outcome: 'completed',
        outputDigest: createHash('sha256').update('Finished CI review').digest('hex'), stopReason: 'end_turn', complete: true });
    };
    const makeService = () => new SessionAutomationService({
      repositories: repos, clock: () => now, ciProviders: providers, authorize: async () => true,
      deliver: async () => { deliveries++; },
      runtime: {
        getSession: async (id: string) => repos.sessions.get(id),
        dispatchRequest: async (request: any) => {
          dispatches++;
          const input = { version: 2, prompt: request.prompt, executionContext: { agentPrompt: request.prompt, actorId: 'ou_owner' }, contentSources: [], executionOptions: { permissionMode: 'ask' } };
          const accepted = bound.acceptTask({ sessionId, runId }, request, { ...input, digest: createHash('sha256').update(canonicalExecutionJson(input)).digest('hex') }, 'back');
          taskId = accepted.task.id;
          const attempt = bound.claimNext({ sessionId, runId })!.attempt!;
          if (mode !== 'not_started') {
            await service.authorizeTask(accepted.task, 'submit');
            bound.markSubmissionPending({ sessionId, runId, taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision },
              { submissionId: 'ci_expiry_submission', inputDigest: repos.execution.getAcceptedTask(taskId)!.input!.digest, resourceRefs: [], authorizationRefs: [] });
          }
          return { id: taskId, status: mode === 'not_started' ? 'queued' : 'running' };
        }
      } as unknown as DutydeckRuntime
    });

    service = makeService();
    const subscription = await service.subscribeCi(sessionId, { ttlSeconds: 60 }, 'ou_owner');
    const cas = repos.config.compareAndSet!.bind(repos.config);
    vi.spyOn(repos.config, 'compareAndSet').mockImplementation(async (key, expected, value) =>
      key === `session_automation/ci/${subscription.id}` && JSON.parse(value).status === 'accepted' ? false : cas(key, expected, value));
    await service.tick();
    const before = JSON.parse((await repos.config.get(`session_automation/ci/${subscription.id}`))!);
    expect(before.status).toBe('dispatching');
    expect(Boolean(before.taskStartedAt)).toBe(mode !== 'not_started');
    expect(repos.execution.getTaskExecution(taskId)!.currentAttempt!.state).toBe(mode === 'not_started' ? 'preparing' : 'active');
    expect(dispatches).toBe(1);
    if (mode === 'settled') settle();

    await service.close();
    vi.mocked(repos.config.compareAndSet).mockImplementation(cas);
    now = new Date('2026-11-17T00:02:00Z');
    service = makeService();
    await service.tick();
    if (mode === 'active') {
      expect(JSON.parse((await repos.config.get(`session_automation/ci/${subscription.id}`))!).status).toBe('accepted');
      settle();
      await service.tick();
    }
    const final = JSON.parse((await repos.config.get(`session_automation/ci/${subscription.id}`))!);
    expect(final.status).toBe(mode === 'not_started' ? 'expired' : 'completed');
    expect(deliveries).toBe(mode === 'not_started' ? 0 : 1);
    expect(dispatches).toBe(1);
    await service.tick();
    expect(deliveries).toBe(mode === 'not_started' ? 0 : 1);
  }, 30_000);
});
