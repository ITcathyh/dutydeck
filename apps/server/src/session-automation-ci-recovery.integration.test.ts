import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { agentConfigSchema, type AttemptResultV1, type Session } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionAutomationService } from './session-automation.js';

const run = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function gitRepository(cwd: string) {
  await run('git', ['init', '-q', cwd]);
  await run('git', ['-C', cwd, 'config', 'user.email', 'test@example.com']);
  await run('git', ['-C', cwd, 'config', 'user.name', 'Test']);
  await run('git', ['-C', cwd, 'commit', '--allow-empty', '-qm', 'initial']);
  await run('git', ['-C', cwd, 'remote', 'add', 'origin', 'git@github.com:octo/repo.git']);
}

function githubResponse(headSha: string, runs: Array<{ id: number; conclusion?: string }> = []) {
  return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs.map(item => ({
    id: item.id, name: 'ci', workflow_id: 9, head_sha: headSha, status: 'completed',
    conclusion: item.conclusion ?? 'success', run_attempt: 1,
    html_url: `https://github.com/octo/repo/actions/runs/${item.id}`,
    created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:01:00Z'
  })) }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    const githubFetch = vi.fn(async () => {
      if (reopened) fetchCallsAfterReopen++;
      return githubResponse(headSha, [{ id: 77, conclusion: 'success' }]);
    }) as typeof fetch;

    const agent = agentConfigSchema.parse({
      id: 'ci-native', name: 'CI fixture', protocol: 'jsonl', command: process.execPath,
      args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
      cwd: directory,
      env: { turn_agent_submission_log: sentLog, turn_agent_gate_dir: gateDir },
      permissionMode: 'ask', timeout: 20,
      capabilities: { pause: false, resume: true }
    });

    const makeRuntime = (target: typeof repos) => new DutydeckRuntime(target, {
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
      githubFetch,
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
    const realDispatch = runtime.dispatch.bind(runtime);
    const dispatchSpy = vi.spyOn(runtime, 'dispatch');
    dispatchSpy.mockImplementation(async (...args: Parameters<typeof runtime.dispatch>) => {
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
    // 恢复路径不重新读取 GitHub API HTTP 材料：重开后 fetch 零调用（源码取得原结果路径亦不查 HEAD）。
    expect(fetchCallsAfterReopen).toBe(0);
    const stored = JSON.parse((await repos.config.get(`session_automation/ci/${sub.id}`))!)!;
    expect(stored.admission.taskId).toBe(taskIdAfterAccept);
    expect(stored.status).toBe('completed');
    // 双 KV 补同一 binding。
    const bindings = (await repos.config.list!('session_automation/task/')).filter(r => r.key.includes(taskIdAfterAccept));
    expect(bindings).toHaveLength(1);
    expect(JSON.parse(bindings[0]!.value)).toMatchObject({ schemaVersion: 2, kind: 'ci', taskId: taskIdAfterAccept, subscriptionId: sub.id });
  }, 30_000);
});
