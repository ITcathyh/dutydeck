import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, symlink, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  agentConfigSchema,
  makeId,
  type BoundExecutionRepository,
  type DriverFactory,
  type DriverSubmission
} from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { JsonlTransport, PipeTransport, commandExists } from './index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) {
    await run();
  }
  vi.restoreAllMocks();
});

const fixture = resolve(process.cwd(), 'packages/transports/tests/fixtures/process-resource-agent.mjs');
const lateFixture = resolve(process.cwd(), 'packages/transports/tests/fixtures/process-resource-late-agent.mjs');

async function setup(
  protocol: 'jsonl' | 'pipe' = 'jsonl',
  env: Record<string, string> = {},
  observeBound?: (bound: BoundExecutionRepository) => void,
  customDbPath?: string
) {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-controlled-resources-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));

  const promptLog = join(dir, 'prompts.jsonl');
  const pidFile = join(dir, 'agent.pid');
  const readyFile = join(dir, 'agent.ready');

  const agent = agentConfigSchema.parse({
    id: `controlled-${protocol}`,
    name: `Controlled-${protocol}`,
    protocol,
    command: process.execPath,
    args: [fixture],
    cwd: dir,
    env: {
      PROCESS_RESOURCE_PROMPT_LOG: promptLog,
      PROCESS_RESOURCE_PID_FILE: pidFile,
      PROCESS_RESOURCE_READY_FILE: readyFile,
      ...env
    },
    permissionMode: 'full-trust',
    timeout: 10,
    capabilities: { pause: false, resume: true }
  });

  const dbPath = customDbPath ?? join(dir, 'db');
  const repos = createRepositories(dbPath, { newDatabaseAuthority: 'ledger_v1' });
  const bind = repos.execution.bind.bind(repos.execution);
  vi.spyOn(repos.execution, 'bind').mockImplementation(claim => {
    const bound = bind(claim);
    observeBound?.(bound);
    return bound;
  });

  const driverFactory: DriverFactory = (ag, proto, onEvent, onExit, sessionId, context) => {
    if (proto === 'pipe') return new PipeTransport(ag, { onEvent, onExit, context });
    return new JsonlTransport(ag, { onEvent, onExit, context });
  };
  driverFactory.controlledResources = proto => proto === 'jsonl' || proto === 'pipe';

  const runtime = new DutydeckRuntime(repos, { driverFactory, cleanupIntervalMs: 0 });
  cleanup.push(async () => {
    await runtime.shutdown();
    repos.close();
  });

  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id });

  return { dir, dbPath, agent, repos, runtime, session, promptLog, pidFile, readyFile, driverFactory };
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('commandExists pure filesystem implementation with PATH regressions', () => {
  it('absent PATH behaves identically to real Node spawn on POSIX default paths', async () => {
    const prior = process.env.PATH;
    try {
      delete process.env.PATH;

      // 真实 Node spawn 在缺省 PATH 下能找到系统默认目录中的命令
      const actualSh = spawnSync('sh', ['-c', 'exit 0']);
      expect(actualSh.status).toBe(0);
      expect(commandExists('sh')).toBe(true);

      const actualNode = spawnSync('node', ['-v']);
      if (actualNode.status === 0) {
        expect(commandExists('node')).toBe(true);
      }

      // 不存在的命令在缺省 PATH 下依然返回 false
      const missing = spawnSync('nonexistent-binary-xyz-404', ['--version']);
      expect(missing.status).not.toBe(0);
      expect(commandExists('nonexistent-binary-xyz-404')).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    }
  });

  it('explicitly empty PATH="" restricts lookup to current directory only and matches real spawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-path-empty-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const origCwd = process.cwd();
    const origPath = process.env.PATH;

    try {
      process.chdir(dir);
      const execName = 'probe-exec.sh';
      const execPath = join(dir, execName);
      await writeFile(execPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await chmod(execPath, 0o755);

      // 显式 PATH=""：系统工具（如 sh）在当前目录找不到，与真实 spawn 一致返回 false / ENOENT
      process.env.PATH = '';
      const actualSh = spawnSync('sh', ['-c', 'exit 0']);
      expect(actualSh.status).not.toBe(0);
      expect(commandExists('sh')).toBe(false);

      // 当前目录中的可执行文件：按 POSIX 空条目语义成功找到
      const actualLocal = spawnSync(execName, [], { cwd: dir });
      expect(actualLocal.status).toBe(0);
      expect(commandExists(execName)).toBe(true);

      // 前置空条目，如 ":/usr/bin"
      process.env.PATH = `:${origPath ?? ''}`;
      expect(commandExists(execName)).toBe(true);
    } finally {
      process.chdir(origCwd);
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });

  it('preserves directories with trailing spaces in PATH without trimming', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-path-space-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const origPath = process.env.PATH;
    try {
      // 创建包含尾随空格的真实目录
      const spaceDir = join(dir, 'bin with space ');
      await mkdir(spaceDir, { recursive: true });

      const execName = 'space-bin.sh';
      const execPath = join(spaceDir, execName);
      await writeFile(execPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await chmod(execPath, 0o755);

      // PATH 包含带尾随空格的目录，保留原始字节，不得执行 trim()
      process.env.PATH = `${spaceDir}:${origPath ?? ''}`;
      const actual = spawnSync(execName, []);
      expect(actual.status).toBe(0);
      expect(commandExists(execName)).toBe(true);
    } finally {
      if (origPath === undefined) delete process.env.PATH;
      else process.env.PATH = origPath;
    }
  });

  it('validates POSIX executable permissions, missing files, directories, and symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-cmd-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    expect(commandExists(process.execPath)).toBe(true);
    expect(commandExists('/bin/sh')).toBe(true);

    const execFile = join(dir, 'my-exec.sh');
    await writeFile(execFile, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    await chmod(execFile, 0o755);
    expect(commandExists(execFile)).toBe(true);

    // 无执行权限文件 (0o644)
    const nonExecFile = join(dir, 'no-exec.txt');
    await writeFile(nonExecFile, 'data', { mode: 0o644 });
    await chmod(nonExecFile, 0o644);
    expect(commandExists(nonExecFile)).toBe(false);

    // 目录不是可执行文件
    expect(commandExists(dir)).toBe(false);
    expect(commandExists('/usr/bin')).toBe(false);

    // 不存在的文件
    expect(commandExists(join(dir, 'not-found-xyz'))).toBe(false);

    // 符号链接指向可执行文件
    const symlinkExec = join(dir, 'symlink-to-exec');
    await symlink(execFile, symlinkExec);
    expect(commandExists(symlinkExec)).toBe(true);

    // 符号链接指向无执行权限文件
    const symlinkNoExec = join(dir, 'symlink-to-no-exec');
    await symlink(nonExecFile, symlinkNoExec);
    expect(commandExists(symlinkNoExec)).toBe(false);

    // 符号链接指向不存在的目标（死链）
    const brokenSymlink = join(dir, 'broken-symlink');
    await symlink(join(dir, 'ghost-target'), brokenSymlink);
    expect(commandExists(brokenSymlink)).toBe(false);
  });
});

describe('controlled resources and fixed submission protocol', () => {
  it('beforeCreate failure aborts with zero child processes spawned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-before-create-failure-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const promptLog = join(dir, 'prompts.jsonl');
    const pidFile = join(dir, 'agent.pid');
    const agent = agentConfigSchema.parse({
      id: 'controlled-before-create',
      name: 'ControlledBeforeCreate',
      protocol: 'jsonl',
      command: process.execPath,
      args: [fixture],
      cwd: dir,
      env: { PROCESS_RESOURCE_PROMPT_LOG: promptLog, PROCESS_RESOURCE_PID_FILE: pidFile },
      permissionMode: 'full-trust',
      timeout: 10,
      capabilities: { pause: false, resume: true }
    });

    const repos = createRepositories(join(dir, 'db'), { newDatabaseAuthority: 'ledger_v1' });
    const bind = repos.execution.bind.bind(repos.execution);
    vi.spyOn(repos.execution, 'bind').mockImplementation(claim => {
      const bound = bind(claim);
      vi.spyOn(bound, 'beforeCreate').mockImplementationOnce(() => {
        throw new Error('simulated beforeCreate ledger write failure');
      });
      return bound;
    });

    let transportInstance: JsonlTransport | undefined;
    let spawnCalled = false;
    const driverFactory: DriverFactory = (ag, _proto, onEvent, onExit, _s, context) => {
      transportInstance = new JsonlTransport(ag, { onEvent, onExit, context });
      const origSpawn = (transportInstance as any).spawnChild.bind(transportInstance);
      (transportInstance as any).spawnChild = (...args: any[]) => {
        spawnCalled = true;
        return origSpawn(...args);
      };
      return transportInstance;
    };
    driverFactory.controlledResources = () => true;

    const runtime = new DutydeckRuntime(repos, { driverFactory, cleanupIntervalMs: 0 });
    cleanup.push(async () => {
      await runtime.shutdown();
      repos.close();
    });

    await runtime.initialize([agent]);

    // start 时 beforeCreate 抛错
    await expect(runtime.start({ agentId: agent.id })).rejects.toThrow('simulated beforeCreate ledger write failure');

    // 核心契约验证：底层的 spawnChild 根本未被调用，零子进程出生
    expect(spawnCalled).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(promptLog)).toBe(false);
    expect((transportInstance as any)?.current).toBeUndefined();
    expect((transportInstance as any)?.owned.size ?? 0).toBe(0);
  });

  it('identity hook failure after spawn retains original child, shuts it down, and records real exit and ledger gone', async () => {
    let capturedChild: ChildProcess | undefined;
    let spawnedChildPid: number | undefined;

    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-identity-failure-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const pidFile = join(dir, 'agent.pid');
    const agent = agentConfigSchema.parse({
      id: 'controlled-identity-fail',
      name: 'ControlledIdentityFail',
      protocol: 'jsonl',
      command: process.execPath,
      args: [fixture],
      cwd: dir,
      env: { PROCESS_RESOURCE_PID_FILE: pidFile },
      permissionMode: 'full-trust',
      timeout: 10,
      capabilities: { pause: false, resume: true }
    });

    const repos = createRepositories(join(dir, 'db'), { newDatabaseAuthority: 'ledger_v1' });
    const bind = repos.execution.bind.bind(repos.execution);
    vi.spyOn(repos.execution, 'bind').mockImplementation(claim => {
      const bound = bind(claim);
      vi.spyOn(bound, 'spawned').mockImplementationOnce((_fence, _resId, _rev, identity) => {
        spawnedChildPid = (identity.locator as any)?.pid;
        throw new Error('simulated spawned identity hook failure');
      });
      return bound;
    });

    let transportInstance: JsonlTransport | undefined;
    const driverFactory: DriverFactory = (ag, _proto, onEvent, onExit, _s, context) => {
      const origSpawned = context.resources.spawned.bind(context.resources);
      context.resources.spawned = (permit, child) => {
        capturedChild = child;
        origSpawned(permit, child);
      };
      transportInstance = new JsonlTransport(ag, { onEvent, onExit, context });
      return transportInstance;
    };
    driverFactory.controlledResources = () => true;

    const runtime = new DutydeckRuntime(repos, { driverFactory, cleanupIntervalMs: 0 });
    cleanup.push(async () => {
      await runtime.shutdown();
      repos.close();
    });

    await runtime.initialize([agent]);

    // 启动因 identity 存储失败抛错
    await expect(runtime.start({ agentId: agent.id })).rejects.toThrow('simulated spawned identity hook failure');

    // 核心契约验证：
    // 1. spawn 实际发生了，捕获了真实 ChildProcess
    expect(capturedChild).toBeDefined();
    expect(spawnedChildPid).toBeDefined();

    // 2. 登记失败必须把真实收尾 Promise 接到 turnTail 上，后续可观察
    const tail: Promise<unknown> | undefined = (transportInstance as any)?.turnTail;
    expect(tail).toBeInstanceOf(Promise);

    // 3. transport 持有了该对象并触发了收口，等待其实际退出
    if (capturedChild!.exitCode === null && capturedChild!.signalCode === null) {
      await once(capturedChild!, 'exit');
    }
    expect(capturedChild!.exitCode !== null || capturedChild!.signalCode !== null).toBe(true);
    expect(isAlive(spawnedChildPid!)).toBe(false);

    // 4. turnTail 真正 resolve 为成功退出，owned 集合已清空
    await expect(tail!).resolves.toBeUndefined();
    expect((transportInstance as any).owned.size).toBe(0);

    // 5. 回读 SQLite 实际 ledger row observations/stage 证明原记录状态为 unknown/gone
    const session = (await repos.sessions.list())[0]!;
    const procResource = repos.execution.getResources(session.id).find(r => r.kind === 'process');
    expect(procResource).toMatchObject({ stage: 'unknown', observations: [{ state: 'gone' }] });
  });

  it('completes turns sequentially, reuses healthy process, and records exact prompt receipts', async () => {
    const h = await setup('jsonl');

    // 验证资源账本登记
    const initialResources = h.repos.execution.getResources(h.session.id);
    const processRes = initialResources.find(r => r.kind === 'process');
    expect(processRes).toBeDefined();
    expect(processRes?.stage).toBe('created');
    expect(processRes?.observations.at(-1)?.state).toBe('live');

    // 发送第一轮
    const first = await h.runtime.send(h.session.id, 'turn-one');
    expect(first.status).toBe('completed');

    await vi.waitFor(() => expect(existsSync(h.pidFile)).toBe(true), { timeout: 3_000 });
    const pid1 = Number(await readFile(h.pidFile, 'utf8'));
    expect(pid1).toBeGreaterThan(0);

    // 发送第二轮：同一健康进程复用
    const second = await h.runtime.send(h.session.id, 'turn-two');
    expect(second.status).toBe('completed');

    const pid2 = Number(await readFile(h.pidFile, 'utf8'));
    expect(pid2).toBe(pid1);

    // 检查实际收件数：精确为 2 条，顺序一致！
    const receivedPrompts = (await readFile(h.promptLog, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(receivedPrompts).toEqual(['turn-one', 'turn-two']);

    // 正常停止后，进程真实退出且资源状态为 gone
    await h.runtime.stop(h.session.id);
    expect(isAlive(pid1)).toBe(false);
    expect(h.repos.execution.getSessionResourceBlockers(h.session.id)).toEqual([]);
    const afterStopRes = h.repos.execution.getResources(h.session.id).find(r => r.kind === 'process');
    expect(afterStopRes?.observations.at(-1)?.state).toBe('gone');
  });

  it('prepareTurn completes new operation for replacement process after holding and ending original ChildProcess', async () => {
    const h = await setup('jsonl');

    const first = await h.runtime.send(h.session.id, 'first-turn');
    expect(first.status).toBe('completed');

    const driver = (h.runtime as any).drivers.get(h.session.id);
    expect(driver).toBeDefined();

    // 持有原 ChildProcess 对象，不能使用裸 PID kill
    const originalChild: ChildProcess = (driver as any).current.child;
    expect(originalChild).toBeDefined();
    const pid1 = originalChild.pid!;

    const exitPromise = once(originalChild, 'exit');
    originalChild.kill('SIGKILL');
    await exitPromise;
    expect(isAlive(pid1)).toBe(false);

    // 发送下一轮：prepareTurn 在新 operation 下启动替代进程
    const second = await h.runtime.send(h.session.id, 'second-turn-after-replacement');
    expect(second.status).toBe('completed');

    const pid2 = Number(await readFile(h.pidFile, 'utf8'));
    expect(pid2).toBeGreaterThan(0);
    expect(pid2).not.toBe(pid1);

    const receivedPrompts = (await readFile(h.promptLog, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(receivedPrompts).toEqual(['first-turn', 'second-turn-after-replacement']);
  });

  it('rejects raw string send in controlled-v1 mode to prevent bypass of frozen intent', async () => {
    const h = await setup('jsonl');
    const driver = (h.runtime as any).drivers.get(h.session.id);
    expect(driver).toBeDefined();

    // 在受控模式下，直接调用 driver.send('string') 必须明确报错拒绝
    await expect(driver.send('raw-string-bypass')).rejects.toThrow('DRIVER_SUBMISSION_REQUIRED');
  });

  it('real send rejects tampering, altered refs, and another driver, but accepts original and same-scope nested once', async () => {
    const h = await setup('jsonl');
    const other = await h.runtime.start({ agentId: h.agent.id });
    const a = h.runtime.getDriver(h.session.id) as any;
    const b = h.runtime.getDriver(other.id) as any;
    const send = a.send.bind(a);

    let checked = false;
    let originalSubmission!: DriverSubmission;
    a.send = async (s: DriverSubmission) => {
      originalSubmission = s;
      // 1. prompt 改动 -> SUBMISSION_DIGEST_CONFLICT
      await expect(send({ ...s, prompt: 'tampered' })).rejects.toMatchObject({ code: 'SUBMISSION_DIGEST_CONFLICT' });
      // 2. inputDigest 改动 -> SUBMISSION_DIGEST_CONFLICT
      await expect(send({ ...s, inputDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'SUBMISSION_DIGEST_CONFLICT' });
      // 3. attemptId 改动 -> SUBMISSION_SCOPE_CONFLICT
      await expect(send({ ...s, attemptId: 'wrong' })).rejects.toMatchObject({ code: 'SUBMISSION_SCOPE_CONFLICT' });
      // 4. taskId 改动 -> SUBMISSION_SCOPE_CONFLICT
      await expect(send({ ...s, taskId: 'wrong-task' })).rejects.toMatchObject({ code: 'SUBMISSION_SCOPE_CONFLICT' });
      // 5. resourceRefs 篡改 -> SUBMISSION_REFERENCES_CONFLICT
      await expect(send({ ...s, resourceRefs: [] })).rejects.toMatchObject({ code: 'SUBMISSION_REFERENCES_CONFLICT' });
      // 6. 跨 driver 调用 -> RESOURCE_PERMIT_INVALID
      await expect(b.send(s)).rejects.toMatchObject({ code: 'RESOURCE_PERMIT_INVALID' });

      // 7. 同 submission 作用域的合法 nested operation 属于允许正例
      const sibling = a.options.context.resources.beginOperation(s.operation);
      try {
        await send({ ...s, operation: sibling });
      } finally {
        a.options.context.resources.creationFinished(sibling, 'created');
      }

      checked = true;
    };

    expect((await h.runtime.send(h.session.id, 'valid-once')).status).toBe('completed');
    expect(checked).toBe(true);

    // 8. 任务完成后，原 submission 已经结束（finished），再次调用实际 send 必须被拒绝（零二次投递）
    await expect(send(originalSubmission)).rejects.toMatchObject({ code: 'SUBMISSION_SCOPE_CONFLICT' });

    // 验证收件严格只有一条 valid-once（负例零投递）
    const lines = (await readFile(h.promptLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toEqual(['valid-once']);
  });

  it('rejects a frozen submission when target process dies after preparation, without spawning a replacement', async () => {
    const h = await setup('jsonl');
    const driver = (h.runtime as any).drivers.get(h.session.id) as JsonlTransport;
    const send = driver.send.bind(driver);

    let spawnedCount = 0;
    const origSpawn = (driver as any).spawnChild.bind(driver);
    (driver as any).spawnChild = (...args: any[]) => {
      spawnedCount++;
      return origSpawn(...args);
    };

    let sendError: unknown;
    let intercepted = false;

    // 在真实提交边界：prepareTurn 已冻结原进程目标，在真正写入前杀死原进程
    driver.send = async (submission: DriverSubmission) => {
      intercepted = true;
      const currentChild: ChildProcess = (driver as any).current.child;
      const exitP = once(currentChild, 'exit');
      currentChild.kill('SIGKILL');
      await exitP;

      try {
        return await send(submission);
      } catch (error) {
        sendError = error;
        throw error;
      }
    };

    const taskResult = await h.runtime.send(h.session.id, 'target-check');
    expect(intercepted).toBe(true);
    expect(taskResult.status).toBe('reconcile_required');

    // 驱动必须明确报错 DRIVER_PROCESS_NOT_READY 拒绝
    expect(sendError).toBeInstanceOf(Error);
    expect((sendError as Error).message).toMatch(/DRIVER_PROCESS_NOT_READY/);

    // 验证底层绝对没有自动补建出第二个替代进程，spawn 总次数严格为 0 次替代（仅初始 1 次）
    expect(spawnedCount).toBe(0); // initial process was spawned before this test hooked spawnChild; replacement count is 0

    // 读取 JSONL 日志，逐行 JSON.parse，断言无 target-check
    const prompts = existsSync(h.promptLog)
      ? (await readFile(h.promptLog, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    expect(prompts).not.toContain('target-check');
  });

  it('real late stdout after timeout is suppressed while next Attempt waits for physical teardown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-late-timeout-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const promptLog = join(dir, 'prompts.jsonl');
    const lateLog = join(dir, 'late.log');

    const agent = agentConfigSchema.parse({
      id: 'controlled-late-timeout',
      name: 'ControlledLateTimeout',
      protocol: 'jsonl',
      command: process.execPath,
      args: [lateFixture],
      cwd: dir,
      env: {
        PROCESS_RESOURCE_PROMPT_LOG: promptLog,
        LATE_EVENT_LOG: lateLog
      },
      timeout: 0.08, // 80ms 真实产品计时器
      permissionMode: 'full-trust',
      capabilities: { pause: false, resume: true }
    });

    const repos = createRepositories(join(dir, 'db'), { newDatabaseAuthority: 'ledger_v1' });
    const driverFactory: DriverFactory = (ag, proto, onEvent, onExit, sessionId, context) => {
      return new JsonlTransport(ag, { onEvent, onExit, context, killGraceMs: 300 });
    };
    driverFactory.controlledResources = () => true;

    const runtime = new DutydeckRuntime(repos, { driverFactory, cleanupIntervalMs: 0 });
    cleanup.push(async () => {
      await runtime.shutdown();
      repos.close();
    });

    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });
    const driver = runtime.getDriver(session.id) as any;
    const old = driver.current;
    expect(old).toBeDefined();
    const oldChild = old.child as ChildProcess;

    // 触发真实 80ms 超时（不要用主动 interrupt 替代）
    const first = await runtime.send(session.id, 'first-timeout');
    expect(first.status).toBe('reconcile_required');

    // 人工决策 confirm_result 释放活动槽
    const a = repos.execution.getTaskExecution(first.id)!.currentAttempt!;
    (runtime as any).bound().settleAttempt(
      { sessionId: session.id, runId: session.runId, taskId: first.id, attemptId: a.attemptId, expectedRevision: a.revision },
      'late-probe-manual',
      {
        kind: 'manual',
        outcome: 'cancelled',
        decision: {
          decisionId: 'late-probe-manual',
          actor: { kind: 'installation_owner', id: 'installation_owner' },
          action: 'confirm_result',
          evidenceRefs: ['real-timeout'],
          resourceChecks: []
        }
      }
    );

    driver.agent.timeout = 10;

    // 在同一 Session 发起下一任务
    const second = runtime.send(session.id, 'second-after-timeout');

    // 等待旧进程在 160ms 输出晚到 stdout
    await vi.waitFor(() => expect(existsSync(lateLog)).toBe(true), { timeout: 3_000 });

    // 确认新任务在等待物理收尾时处于 preparing 状态
    const tasks = await runtime.getTasks(session.id);
    expect(tasks).toHaveLength(2);
    const next = tasks.find(t => t.id !== first.id)!;
    expect(repos.execution.getTaskExecution(next.id)!.currentAttempt!.state).toBe('preparing');

    // 第二任务完成
    const result = await second;
    expect(result.status).toBe('completed');

    // 验证：旧进程的迟到事件绝不进入会话事件日志
    const events = await runtime.getEvents(session.id);
    const eventsStr = JSON.stringify(events);
    expect(eventsStr).not.toContain('STALE-FIRST');
    expect(eventsStr).not.toContain('STALE-ERROR');

    // 验证：原 ChildProcess 真实退出已证明
    expect(oldChild.exitCode !== null || oldChild.signalCode !== null).toBe(true);

    // 验证：收件日志恰好为两次，顺序一致，旧任务零重发
    expect((await readFile(promptLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l))).toEqual(['first-timeout', 'second-after-timeout']);
  });

  it('surfaces a failed stop tail at the next send instead of hiding cleanup failure, with safe cleanup in finally', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-stop-tail-failure-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const agent = agentConfigSchema.parse({
      id: 'stop-tail-fail',
      name: 'StopTailFail',
      protocol: 'jsonl',
      command: process.execPath,
      args: [fixture],
      cwd: dir,
      env: {},
      permissionMode: 'deny-all',
      timeout: 30,
      capabilities: { pause: false, resume: true }
    });

    const transport = new JsonlTransport(agent, { onEvent() {}, killGraceMs: 10 });
    const internal = transport as any;
    const realSignalGroup = internal.signalGroup.bind(transport);

    try {
      await transport.start();
      const first = transport.send('hang-forever').catch((error: unknown) => error);

      await vi.waitFor(() => expect(internal.activeTurn).toBeTruthy(), { timeout: 3_000 });

      // 屏蔽真实信号，使被收口的组无法证明退出，terminate 必然 reject
      internal.signalGroup = () => {};
      internal.current.child.stdout.emit('error', new Error('forced read failure'));

      await vi.waitFor(() => expect(internal.turnTail).toBeInstanceOf(Promise), { timeout: 3_000 });
      // 收尾 Promise 必须真实 reject，不能被转成 resolved 隐藏
      await expect(internal.turnTail).rejects.toThrow(/did not exit/);
      await first;

      // 下一次 send 会先 await turnTail，必须看到同一清理失败而不是静默补建
      await expect(transport.send('next')).rejects.toThrow(/did not exit/);
    } finally {
      // 保证必定恢复信号并真正收口子进程，即使断言失败也不遗留孤儿进程
      internal.signalGroup = realSignalGroup;
      await transport.stop();
      expect(await transport.isStopped()).toBe(true);
    }
  });

  it('reopens SQLite repository and ensures completed task has zero resend and preserves idempotency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-reopen-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const dbPath = join(dir, 'persisted-ledger.db');
    const promptLog = join(dir, 'prompts.jsonl');
    const agent = agentConfigSchema.parse({
      id: 'persisted-agent',
      name: 'PersistedAgent',
      protocol: 'jsonl',
      command: process.execPath,
      args: [fixture],
      cwd: dir,
      env: { PROCESS_RESOURCE_PROMPT_LOG: promptLog },
      permissionMode: 'full-trust',
      timeout: 10,
      capabilities: { pause: false, resume: true }
    });

    const driverFactory: DriverFactory = (ag, proto, onEvent, onExit, sessionId, context) => {
      if (proto === 'pipe') return new PipeTransport(ag, { onEvent, onExit, context });
      return new JsonlTransport(ag, { onEvent, onExit, context });
    };
    driverFactory.controlledResources = () => true;

    // 步骤 1：首次打开库并注册清理，执行并完成任务
    const repos1 = createRepositories(dbPath, { newDatabaseAuthority: 'ledger_v1' });
    const runtime1 = new DutydeckRuntime(repos1, { driverFactory, cleanupIntervalMs: 0 });
    let runtime1Closed = false;
    cleanup.push(async () => {
      if (!runtime1Closed) {
        await runtime1.shutdown();
        repos1.close();
        runtime1Closed = true;
      }
    });

    await runtime1.initialize([agent]);
    const session = await runtime1.start({ agentId: agent.id });

    const taskReqKey = 'stable-client-idempotency-key';
    const firstTask = await runtime1.dispatch(session.id, 'persisted-prompt', 'queue', 'persisted-prompt', undefined, undefined, taskReqKey);
    await vi.waitFor(async () => {
      const t = await repos1.tasks.get?.(firstTask.id);
      expect(t?.status).toBe('completed');
    }, { timeout: 4_000 });

    // 确认子进程收到了 1 次 prompt
    const log1 = (await readFile(promptLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    expect(log1).toEqual(['persisted-prompt']);

    // 步骤 2：模拟来源丢回执或守护进程关闭：完全 close 数据库与 runtime，仅在成功后标记已关闭
    await runtime1.shutdown();
    repos1.close();
    runtime1Closed = true;

    // 步骤 3：重新打开同一个磁盘 SQLite 库并注册清理，使用新 Runtime 实例接管
    const repos2 = createRepositories(dbPath, { newDatabaseAuthority: 'ledger_v1' });
    const runtime2 = new DutydeckRuntime(repos2, { driverFactory, cleanupIntervalMs: 0 });
    let runtime2Closed = false;
    cleanup.push(async () => {
      if (!runtime2Closed) {
        await runtime2.shutdown();
        repos2.close();
        runtime2Closed = true;
      }
    });

    await runtime2.initialize([agent]);

    // 重投相同 idempotencyKey 的请求（模拟丢回执后客户端重试）：验证命中原 Task，状态为 completed，零 resend！
    const replayTask = await runtime2.dispatch(session.id, 'persisted-prompt', 'queue', 'persisted-prompt', undefined, undefined, taskReqKey);
    expect(replayTask.id).toBe(firstTask.id);
    expect(replayTask.replayed).toBe(true);
    expect(replayTask.status).toBe('completed');

    // 子进程收件数严格保持为 1，绝无第二次 send！
    const log2 = (await readFile(promptLog, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    expect(log2).toEqual(['persisted-prompt']);

    await runtime2.shutdown();
    repos2.close();
    runtime2Closed = true;
  });

  it('stops cleanly and suppresses late exit notifications during stop', async () => {
    const exitNotified = vi.fn();
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-late-exit-test-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const pidFile = join(dir, 'agent.pid');
    const agent = agentConfigSchema.parse({
      id: 'controlled-late-exit',
      name: 'ControlledLateExit',
      protocol: 'jsonl',
      command: process.execPath,
      args: [fixture],
      cwd: dir,
      env: { PROCESS_RESOURCE_PID_FILE: pidFile },
      permissionMode: 'full-trust',
      timeout: 10,
      capabilities: { pause: false, resume: true }
    });

    const repos = createRepositories(join(dir, 'db'), { newDatabaseAuthority: 'ledger_v1' });
    const driverFactory: DriverFactory = (ag, _proto, onEvent, onExit, _s, context) => {
      return new JsonlTransport(ag, { onEvent, onExit: code => { exitNotified(code); onExit(code); }, context });
    };
    driverFactory.controlledResources = () => true;

    const runtime = new DutydeckRuntime(repos, { driverFactory, cleanupIntervalMs: 0 });
    cleanup.push(async () => {
      await runtime.shutdown();
      repos.close();
    });

    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id });

    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 3_000 });
    const pid = Number(await readFile(pidFile, 'utf8'));

    // 执行主动 stop，停止期间子进程的 exit 不触发外层 onExit
    await runtime.stop(session.id);
    expect(isAlive(pid)).toBe(false);
    expect(exitNotified).not.toHaveBeenCalled();
  });

  it('PipeTransport supports controlled resources, turns, and process teardown', async () => {
    const h = await setup('pipe');

    const res = await h.runtime.send(h.session.id, 'pipe-test');
    expect(res.status).toBe('completed');

    const prompts = (await readFile(h.promptLog, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(prompts).toEqual(['pipe-test']);

    const pid = Number(await readFile(h.pidFile, 'utf8'));
    await h.runtime.stop(h.session.id);
    expect(isAlive(pid)).toBe(false);
  });
});
