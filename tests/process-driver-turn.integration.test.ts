import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import { JsonlTransport, PipeTransport } from '../packages/transports/src/index.js';

const dirs: string[] = [];
const runtimes: DutydeckRuntime[] = [];
const activeTransports: (JsonlTransport | PipeTransport)[] = [];
const openRepos: ReturnType<typeof createRepositories>[] = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const transport of activeTransports.splice(0)) {
    try { await transport.stop(); } catch (error) { errors.push(error); }
  }
  for (const runtime of runtimes.splice(0)) {
    try { await runtime.shutdown(); } catch (error) { errors.push(error); }
  }
  for (const repo of openRepos.splice(0)) {
    try { repo.close(); } catch (error) { errors.push(error); }
  }
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  if (errors.length) throw new AggregateError(errors, 'Process integration cleanup failed');
});

function createTestRepos(dbPath: string) {
  const repos = createRepositories(dbPath, { newDatabaseAuthority: 'ledger_v1' });
  openRepos.push(repos);
  return repos;
}

describe('JSONL/Pipe runtime turn integration', () => {
  for (const protocol of ['jsonl', 'pipe'] as const) {
    it(`[${protocol}] isolates a timed-out process while the next queued task is preparing`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dutydeck-turn-retired-')); dirs.push(dir);
      const repos = createTestRepos(join(dir, 'test.sqlite'));
      const log = join(dir, 'submitted.jsonl'), terminateGate = join(dir, 'terminate');
      let entered!: () => void, release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const preparing = new Promise<void>(resolve => { release = resolve; });
      let transport!: JsonlTransport;
      const runtime = new DutydeckRuntime(repos, {
        driverIdleTimeoutMs: 0,
        sessionPrompt: async (_session, prompt) => {
          if (prompt === 'second') { entered(); await preparing; }
          return prompt;
        },
        driverFactory: (agent, _protocol, onEvent, onExit) => {
          transport = new (protocol === 'jsonl' ? JsonlTransport : PipeTransport)(agent, { onEvent, onExit, killGraceMs: 2_000 });
          activeTransports.push(transport); return transport;
        }
      });
      runtimes.push(runtime);
      await runtime.initialize([{
        id: 'retired', name: 'Retired', protocol, command: process.execPath,
        args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')], cwd: dir,
        env: { turn_agent_submission_log: log, turn_agent_terminate_gate: terminateGate },
        permissionMode: 'deny-all', timeout: 0.3, capabilities: { pause: false, resume: true }, builtin: false
      }]);
      const session = await runtime.start({ agentId: 'retired' });
      const original = (transport as any).current.child;
      const exited = once(original, 'exit');
      try {
        const first = await runtime.dispatch(session.id, 'hang-forever');
        const second = await runtime.dispatch(session.id, 'second');
        const third = await runtime.dispatch(session.id, 'third');
        await vi.waitFor(async () => {
          expect((await repos.tasks.get!(first.id))?.status).toBe('reconcile_required');
        });
        const exec = repos.execution.getTaskExecution(first.id)!;
        const attempt = exec.attempts[0]!;
        const fence = { sessionId: session.id, runId: session.runId, taskId: first.id, attemptId: attempt.attemptId, expectedRevision: attempt.revision };
        (runtime as any).bound().settleAttempt(fence, `settle:${first.id}`, {
          kind: 'manual',
          outcome: 'failed',
          decision: { decisionId: `dec:${first.id}`, action: 'confirm_result', actor: { kind: 'installation_owner', id: 'installation_owner' }, evidenceRefs: ['manual_resolution'], resourceChecks: [] }
        });
        (runtime as any).queueBlocked.delete(session.id);
        await (runtime as any).projectQueue(session.id);
        (runtime as any).scheduleQueue(session.id);
        await enteredPromise;
        expect((await repos.tasks.get!(first.id))?.status).toBe('failed');
        expect((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(['hang-forever']);
        await writeFile(terminateGate, 'release');
        expect((await exited)[0]).toBe(7);
        expect((await repos.tasks.get!(second.id))?.status).toBe('running');
        release();
        await vi.waitFor(async () => {
          expect((await repos.tasks.get!(second.id))?.status).toBe('completed');
          expect((await repos.tasks.get!(third.id))?.status).toBe('completed');
        });
        expect((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual(['hang-forever', 'second', 'third']);
        const events = await runtime.getEvents(session.id);
        expect(events.some(event => event.type === 'error' && (event.data as { message?: string })?.message === 'retired process error')).toBe(false);
        expect((await repos.sessions.get(session.id))?.state).not.toBe('failed');
      } finally { release(); await writeFile(terminateGate, 'release'); }
    });
  }
  for (const protocol of ['jsonl', 'pipe'] as const) {
    it(`[${protocol}] completes task and records all structured output before returning from runtime.send`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `dutydeck-turn-int-${protocol}-`));
      dirs.push(dir);
      const repos = createTestRepos(join(dir, 'test.sqlite'));
      const runtime = new DutydeckRuntime(repos, {
        driverIdleTimeoutMs: 0,
        driverFactory: (agent, _proto, onEvent, onExit) => {
          const transport = new (protocol === 'jsonl' ? JsonlTransport : PipeTransport)(agent, { onEvent, onExit });
          activeTransports.push(transport);
          return transport;
        }
      });
      runtimes.push(runtime);

      const agentConfig = {
        id: `probe-${protocol}`,
        name: `Probe-${protocol}`,
        protocol,
        command: process.execPath,
        args: [resolve('tests/fixtures/jsonl-agent.mjs')],
        cwd: dir,
        env: {},
        permissionMode: 'deny-all' as const,
        timeout: 5,
        capabilities: { pause: false, resume: true },
        builtin: false
      };

      await runtime.initialize([agentConfig]);
      const session = await runtime.start({ agentId: agentConfig.id });

      // 核心契约：runtime.send 必须等到驱动收到 completed 并交付事件后才返回，返回时任务状态必须是 completed
      const task = await runtime.send(session.id, 'hello');
      expect(task.status).toBe('completed');
      const events = await runtime.getEvents(session.id);
      expect(events.some(e => e.type === 'error')).toBe(false);

      const stored = await repos.tasks.get!(task.id);
      expect(stored?.status).toBe('completed');

      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain('thinking');
      expect(eventTypes).toContain('tool_call');
      expect(eventTypes).toContain('tool_result');
      expect(eventTypes).toContain('text');
    });
  }

  it('reuses the same process across consecutive sequential turns in Runtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-turn-seq-'));
    dirs.push(dir);
    const repos = createTestRepos(join(dir, 'test.sqlite'));
    let transportInstance: JsonlTransport | undefined;
    const runtime = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      driverFactory: (agent, _proto, onEvent, onExit) => {
        transportInstance = new JsonlTransport(agent, { onEvent, onExit });
        activeTransports.push(transportInstance);
        return transportInstance;
      }
    });
    runtimes.push(runtime);

    const agentConfig = {
      id: 'probe-seq',
      name: 'ProbeSeq',
      protocol: 'jsonl' as const,
      command: process.execPath,
      args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
      cwd: dir,
      env: {},
      permissionMode: 'deny-all' as const,
      timeout: 5,
      capabilities: { pause: false, resume: true },
      builtin: false
    };

    await runtime.initialize([agentConfig]);
    const session = await runtime.start({ agentId: agentConfig.id });

    // 第一轮任务
    const t1 = await runtime.send(session.id, 'turn-1');
    expect(t1.status).toBe('completed');
    const pid1 = (transportInstance as any).current?.pid;
    expect(pid1).toBeGreaterThan(0);

    // 第二轮任务：复用同一进程
    const t2 = await runtime.send(session.id, 'turn-2');
    expect(t2.status).toBe('completed');
    const pid2 = (transportInstance as any).current?.pid;
    expect(pid2).toBe(pid1);
  });

  it('queues three consecutive tasks via dispatch and executes them in order to completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-turn-queue-'));
    dirs.push(dir);
    const repos = createTestRepos(join(dir, 'test.sqlite'));
    const promptsSubmitted: string[] = [];
    const runtime = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      driverFactory: (agent, _proto, onEvent, onExit) => {
        const transport = new JsonlTransport(agent, { onEvent, onExit });
        activeTransports.push(transport);
        const origSend = transport.send.bind(transport);
        transport.send = (prompt: string) => {
          promptsSubmitted.push(prompt);
          return origSend(prompt);
        };
        return transport;
      }
    });
    runtimes.push(runtime);

    const agentConfig = {
      id: 'probe-queue',
      name: 'ProbeQueue',
      protocol: 'jsonl' as const,
      command: process.execPath,
      args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
      cwd: dir,
      env: {},
      permissionMode: 'deny-all' as const,
      timeout: 5,
      capabilities: { pause: false, resume: true },
      builtin: false
    };

    await runtime.initialize([agentConfig]);
    const session = await runtime.start({ agentId: agentConfig.id });

    // 通过 durable queue 连续排队三个任务
    const d1 = await runtime.dispatch(session.id, 'queue-1', 'queue');
    const d2 = await runtime.dispatch(session.id, 'queue-2', 'queue');
    const d3 = await runtime.dispatch(session.id, 'queue-3', 'queue');

    // 等待三个任务全部完成
    await vi.waitFor(async () => {
      const task1 = await repos.tasks.get!(d1.id);
      const task2 = await repos.tasks.get!(d2.id);
      const task3 = await repos.tasks.get!(d3.id);
      expect(task1?.status).toBe('completed');
      expect(task2?.status).toBe('completed');
      expect(task3?.status).toBe('completed');
    }, { timeout: 8_000 });

    // 每条提示词恰好提交一次
    expect(promptsSubmitted).toEqual(['queue-1', 'queue-2', 'queue-3']);

    const events = await runtime.getEvents(session.id);
    const texts = events.filter(e => e.type === 'text').map(e => (e.data as any)?.text);
    expect(texts).toContain('echo:queue-1');
    expect(texts).toContain('echo:queue-2');
    expect(texts).toContain('echo:queue-3');
  });

  it('does not cancel queue or fail session when process exits non-zero during turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-turn-nonzero-'));
    dirs.push(dir);
    const repos = createTestRepos(join(dir, 'test.sqlite'));
    const runtime = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      driverFactory: (agent, _proto, onEvent, onExit) => {
        const transport = new JsonlTransport(agent, { onEvent, onExit });
        activeTransports.push(transport);
        return transport;
      }
    });
    runtimes.push(runtime);

    const agentConfig = {
      id: 'probe-nonzero',
      name: 'ProbeNonZero',
      protocol: 'jsonl' as const,
      command: process.execPath,
      args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
      cwd: dir,
      env: {},
      permissionMode: 'deny-all' as const,
      timeout: 5,
      capabilities: { pause: false, resume: true },
      builtin: false
    };

    await runtime.initialize([agentConfig]);
    const session = await runtime.start({ agentId: agentConfig.id });

    // 第一个任务触发子进程 exit(2) 退出且无 completed
    // 契约规定：已提交但未确认完成的任务进入 reconcile_required，不向 Runtime 发送全局 onExit 导致 Session 变为 failed
    const t1 = await runtime.send(session.id, 'exit-without-completed');
    expect(t1.status).toBe('reconcile_required');

    // 检查数据库中该任务的状态确为 reconcile_required
    const tasks = await repos.tasks.listBySession!(session.id);
    const failedTask = tasks.find(t => t.prompt === 'exit-without-completed')!;
    expect(failedTask?.status).toBe('reconcile_required');

    // Session 状态不应被设为 failed，而应恢复为可继续工作的状态（interrupted 等待恢复）
    const s = await repos.sessions.get(session.id);
    expect(s?.state).not.toBe('failed');

    // 对该任务进行受控结算，使 session 恢复就绪
    const exec = repos.execution.getTaskExecution(failedTask.id)!;
    const attempt = exec.attempts[0]!;
    const fence = { sessionId: session.id, runId: session.runId, taskId: failedTask.id, attemptId: attempt.attemptId, expectedRevision: attempt.revision };
    (runtime as any).bound().settleAttempt(fence, `settle:${failedTask.id}`, {
      kind: 'manual',
      outcome: 'failed',
      decision: { decisionId: `dec:${failedTask.id}`, action: 'confirm_result', actor: { kind: 'installation_owner', id: 'installation_owner' }, evidenceRefs: ['manual_resolution'], resourceChecks: [] }
    });

    // 第二个任务应该能够重新启动健康子进程并正常完成
    const t2 = await runtime.send(session.id, 'normal-after-exit');
    expect(t2.status).toBe('completed');
  });

  it('isolates unowned error/completed events while next task is in preparation before send', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-turn-unowned-'));
    dirs.push(dir);
    const repos = createTestRepos(join(dir, 'test.sqlite'));

    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>(r => { enteredResolve = r; });
    const release = new Promise<void>(r => { releaseResolve = r; });

    let transport!: JsonlTransport;
    const runtime = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      sessionPrompt: async (_session, prompt) => {
        if (prompt === 'second-task') {
          enteredResolve();
          await release;
        }
        return prompt;
      },
      driverFactory: (agent, _proto, onEvent, onExit) => {
        transport = new JsonlTransport(agent, { onEvent, onExit, killGraceMs: 30 });
        activeTransports.push(transport);
        return transport;
      }
    });
    runtimes.push(runtime);

    const agentConfig = {
      id: 'probe-unowned',
      name: 'ProbeUnowned',
      protocol: 'jsonl' as const,
      command: process.execPath,
      args: [resolve('tests/fixtures/process-driver-turn-agent.mjs')],
      cwd: dir,
      env: {},
      permissionMode: 'deny-all' as const,
      timeout: 5,
      capabilities: { pause: false, resume: true },
      builtin: false
    };

    await runtime.initialize([agentConfig]);
    const session = await runtime.start({ agentId: agentConfig.id });

    // 第一轮任务正常完成
    const t1 = await runtime.send(session.id, 'first-task');
    expect(t1.status).toBe('completed');

    // 第二轮任务开始执行，但此时卡在 sessionPrompt（任务处于 running，但尚未调用 driver.send）
    const secondSend = runtime.send(session.id, 'second-task');
    await entered;

    // 此时子进程自发输出未归属的 error 和 completed
    const child = (transport as any).current.child;
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'error', message: 'unsolicited old error' })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'completed', stopReason: 'error' })}\n`));

    // 稍等以确认事件被 transport 内部消化，未污染 Runtime
    await new Promise(r => setTimeout(r, 60));

    // 释放 sessionPrompt 门禁，让第二任务正常调用 driver.send
    releaseResolve();
    const t2 = await secondSend;

    // 关键断言：第二任务必须正常 completed，绝不能被刚才的 unsolicited error 污染为 failed！
    expect(t2.status).toBe('completed');
    const events2 = await runtime.getEvents(session.id);
    expect(events2.some(e => e.type === 'error' && e.taskId === t2.id)).toBe(false);
  });
});
