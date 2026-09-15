import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentConfigSchema, type AgentConfig } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';

const lifecycleFixture = resolve('tests/fixtures/acp-lifecycle-agent.mjs');
const turnFixture = resolve('tests/fixtures/process-driver-turn-agent.mjs');
const processTreeFixture = resolve('tests/fixtures/process-tree-agent.mjs');

const directories: string[] = [];
const runtimes: DutydeckRuntime[] = [];
const repositories: ReturnType<typeof createRepositories>[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown().catch(() => {});
  for (const repos of repositories.splice(0)) repos.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function acpWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-acp-'));
  directories.push(dir);
  // fixture 的 session/new 在 release 文件出现前挂起；预置好让正常启动不等待。
  await writeFile(join(dir, 'release'), 'ready');
  return dir;
}

function acpAgent(cwd: string): AgentConfig {
  return agentConfigSchema.parse({
    id: 'lifecycle-agent', name: 'Lifecycle Agent', command: process.execPath,
    args: [lifecycleFixture], protocol: 'acp', cwd,
    // 小写 snake_case：既被 ACPX 持久化进 session_options.env，又指向本轮私有目录。
    env: { lifecycle_directory: cwd }, permissionMode: 'full-trust', timeout: 30,
    capabilities: { pause: false, resume: true }
  });
}

function open(dir: string, database: string) {
  const repos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
  repositories.push(repos);
  const runtime = new DutydeckRuntime(repos, { workspaceRoot: join(dir, 'workspaces'), cleanupIntervalMs: 0 });
  runtimes.push(runtime);
  return { repos, runtime };
}

async function nativeCalls(cwd: string) {
  return (await readFile(join(cwd, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
const pidGone = (pid: number) => new Promise<boolean>(resolve => {
  try { process.kill(pid, 0); resolve(false); } catch { resolve(true); }
});

describe('真实 AcpxAdapter + patched acpx + 持久 sessionKey 的 Runtime 生命周期', () => {
  it('同一 Runtime Session stop→resume 后继续提交：复用原生会话（session/new 仅一次）且 isStopped 为真实证明', async () => {
    const dir = await acpWorkspace();
    const { repos, runtime } = open(dir, join(dir, 'state.db'));
    await runtime.initialize([acpAgent(dir)]);
    const session = await runtime.start({ agentId: 'lifecycle-agent', cwd: dir });
    expect(session.protocol).toBe('acp');

    await runtime.send(session.id, 'first');
    const firstTexts = (await runtime.getEvents(session.id)).filter(e => e.type === 'text').map(e => (e.data as any).text);
    expect(firstTexts).toEqual(['first', 'lifecycle-native-session']);

    // 真实 stop：底层 AcpxAdapter 关闭句柄并经 isStopped 物理核验。
    await runtime.stop(session.id);
    expect((await runtime.getSession(session.id))?.state).toBe('stopped');
    const stoppedDriver = (runtime as any).blockedDrivers?.get(session.id);
    expect(stoppedDriver).toBeUndefined();
    expect(runtime.getDriverStopBlock(session.id)).toBeUndefined();

    // 同一 Runtime、同一 Session resume 后继续提交。
    await runtime.resume(session.id);
    await runtime.send(session.id, 'second');
    const texts = (await runtime.getEvents(session.id)).filter(e => e.type === 'text').map(e => (e.data as any).text);
    expect(texts).toEqual(['first', 'lifecycle-native-session', 'second', 'lifecycle-native-session']);
    expect((await runtime.getTasks(session.id)).map(t => t.status)).toEqual(['completed', 'completed']);

    const calls = await nativeCalls(dir);
    expect(calls.filter(c => c.method === 'session/new')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'session/load').length).toBeGreaterThanOrEqual(1);

    // 最终关闭并证明 fixture agent 进程真实退出。
    const pid = Number(calls.find(c => c.method === 'spawn')?.pid ?? 0);
    expect(pid).toBeGreaterThan(0);
    await runtime.stop(session.id);
    await expect.poll(() => pidGone(pid), { timeout: 5_000 }).toBe(true);
    expect((await repos.config.get('runtime_driver_stop_block:' + session.id)) ?? '').toBe('');
  });

  it('stop→restart 更换 runId 与 driver 后，新运行仍复用同一原生会话', async () => {
    const dir = await acpWorkspace();
    const { runtime } = open(dir, join(dir, 'state.db'));
    await runtime.initialize([acpAgent(dir)]);
    const session = await runtime.start({ agentId: 'lifecycle-agent', cwd: dir });
    const firstRunId = session.runId;
    const firstDriver = runtime.getDriver(session.id);

    await runtime.send(session.id, 'before');
    await runtime.stop(session.id);
    const restarted = await runtime.restart(session.id);
    expect(restarted.runId).not.toBe(firstRunId);
    expect(runtime.getDriver(session.id)).not.toBe(firstDriver);

    await runtime.send(session.id, 'after');
    const calls = await nativeCalls(dir);
    expect(calls.filter(c => c.method === 'session/new')).toHaveLength(1);
    expect((await runtime.getTasks(session.id)).map(t => t.status)).toEqual(['completed', 'completed']);
  });

  it('daemon 重开（新 Runtime + 同一 SQLite）resume 后继续提交：持久 sessionKey 让原生上下文不被丢弃', async () => {
    const dir = await acpWorkspace();
    const database = join(dir, 'state.db');
    const sessionId = await (async () => {
      const first = open(dir, database);
      await first.runtime.initialize([acpAgent(dir)]);
      const session = await first.runtime.start({ agentId: 'lifecycle-agent', cwd: dir });
      await first.runtime.send(session.id, 'first');
      await first.runtime.shutdown();
      const index = runtimes.indexOf(first.runtime);
      if (index >= 0) runtimes.splice(index, 1);
      const repoIndex = repositories.indexOf(first.repos);
      if (repoIndex >= 0) repositories.splice(repoIndex, 1);
      first.repos.close();
      return session.id;
    })();

    const restored = open(dir, database);
    await restored.runtime.initialize([acpAgent(dir)]);
    await restored.runtime.resume(sessionId);
    await restored.runtime.send(sessionId, 'second');
    const texts = (await restored.runtime.getEvents(sessionId)).filter(e => e.type === 'text').map(e => (e.data as any).text);
    expect(texts).toEqual(['first', 'lifecycle-native-session', 'second', 'lifecycle-native-session']);

    const calls = await nativeCalls(dir);
    // 重开后是新进程（持久 load），但全流程原生 session 只 new 过一次。
    expect(calls.filter(c => c.method === 'session/new')).toHaveLength(1);
    expect(calls.filter(c => c.method === 'spawn').length).toBeGreaterThanOrEqual(2);
  });
});

describe('本地 JSONL/Pipe 与 Runtime 停止资源核验与正常流转', () => {
  it('真实 JsonlTransport：send 正常完成且对应 Task completed，stop 证明退出且不留 blocker，stop→resume 继续第二轮', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-jsonl-'));
    directories.push(dir);
    const subLog = join(dir, 'submissions.jsonl');
    const { repos, runtime } = open(dir, join(dir, 'state.db'));
    const agent = agentConfigSchema.parse({
      id: 'jsonl-agent', name: 'JSONL', command: process.execPath, args: [turnFixture],
      protocol: 'jsonl', cwd: dir, env: { turn_agent_submission_log: subLog }, permissionMode: 'ask', timeout: 10,
      capabilities: { pause: false, resume: true }
    });
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: 'jsonl-agent', cwd: dir });

    // 1. 首轮 send 正常结束，且 Task 对应 completed
    const task1 = await runtime.send(session.id, 'first-turn');
    expect(task1.status).toBe('completed');
    expect((await runtime.getTasks(session.id)).map(t => t.status)).toEqual(['completed']);
    const events1 = await runtime.getEvents(session.id);
    expect(events1.some(e => e.type === 'thinking' && (e.data as any).text === 'thinking:first-turn')).toBe(true);
    expect(events1.some(e => e.type === 'text' && (e.data as any).text === 'echo:first-turn')).toBe(true);

    // 2. stop 成功证明退出，不残留 stop blocker
    await runtime.stop(session.id);
    expect((await runtime.getSession(session.id))?.state).toBe('stopped');
    expect(runtime.getDriverStopBlock(session.id)).toBeUndefined();
    expect((await repos.config.get('runtime_driver_stop_block:' + session.id)) ?? '').toBe('');

    // 3. resume 后继续第二轮
    await runtime.resume(session.id);
    const task2 = await runtime.send(session.id, 'second-turn');
    expect(task2.status).toBe('completed');
    expect((await runtime.getTasks(session.id)).map(t => t.status)).toEqual(['completed', 'completed']);

    const logs = (await readFile(subLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(logs).toEqual(['first-turn', 'second-turn']);
  });

  it('真实 JsonlTransport：stop→restart 更换 runId 与 driver 后，新运行继续提交并正常结算', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-jsonl-restart-'));
    directories.push(dir);
    const { runtime } = open(dir, join(dir, 'state.db'));
    const agent = agentConfigSchema.parse({
      id: 'jsonl-agent', name: 'JSONL', command: process.execPath, args: [turnFixture],
      protocol: 'jsonl', cwd: dir, permissionMode: 'ask', timeout: 10,
      capabilities: { pause: false, resume: true }
    });
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: 'jsonl-agent', cwd: dir });
    const firstRunId = session.runId;
    const firstDriver = runtime.getDriver(session.id);

    const task1 = await runtime.send(session.id, 'before-restart');
    expect(task1.status).toBe('completed');

    await runtime.stop(session.id);
    expect(runtime.getDriverStopBlock(session.id)).toBeUndefined();

    const restarted = await runtime.restart(session.id);
    expect(restarted.runId).not.toBe(firstRunId);
    expect(runtime.getDriver(session.id)).not.toBe(firstDriver);

    const task2 = await runtime.send(session.id, 'after-restart');
    expect(task2.status).toBe('completed');
    expect((await runtime.getTasks(session.id)).map(t => t.status)).toEqual(['completed', 'completed']);
  });

  it('真实 JsonlTransport：重开 Runtime+同 SQLite 后恢复，发送新一轮且无旧子进程/输出污染', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-jsonl-reopen-'));
    directories.push(dir);
    const database = join(dir, 'state.db');
    const readyFile = join(dir, 'ready.pid');
    const subLog = join(dir, 'subs.jsonl');
    const agent = agentConfigSchema.parse({
      id: 'jsonl-agent', name: 'JSONL', command: process.execPath, args: [turnFixture],
      protocol: 'jsonl', cwd: dir,
      env: { turn_agent_ready_file: readyFile, turn_agent_submission_log: subLog },
      permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }
    });

    let firstPid = 0;
    const sessionId = await (async () => {
      const first = open(dir, database);
      await first.runtime.initialize([agent]);
      const session = await first.runtime.start({ agentId: 'jsonl-agent', cwd: dir });
      await vi.waitFor(async () => {
        firstPid = Number((await readFile(readyFile, 'utf8')).trim());
        expect(firstPid).toBeGreaterThan(0);
      });
      const t1 = await first.runtime.send(session.id, 'first-daemon-task');
      expect(t1.status).toBe('completed');

      await first.runtime.shutdown();
      const index = runtimes.indexOf(first.runtime);
      if (index >= 0) runtimes.splice(index, 1);
      const repoIndex = repositories.indexOf(first.repos);
      if (repoIndex >= 0) repositories.splice(repoIndex, 1);
      first.repos.close();
      return session.id;
    })();

    // 证明旧子进程已随 shutdown 彻底退出
    expect(firstPid).toBeGreaterThan(0);
    await expect.poll(() => pidGone(firstPid), { timeout: 5_000 }).toBe(true);

    // 新 Runtime 打开同一数据库恢复
    const restored = open(dir, database);
    await restored.runtime.initialize([agent]);
    await restored.runtime.resume(sessionId);
    const t2 = await restored.runtime.send(sessionId, 'second-daemon-task');
    expect(t2.status).toBe('completed');

    expect((await restored.runtime.getTasks(sessionId)).map(t => t.status)).toEqual(['completed', 'completed']);
    const texts = (await restored.runtime.getEvents(sessionId)).filter(e => e.type === 'text').map(e => (e.data as any).text);
    expect(texts).toEqual(['first-daemon-task', 'echo:first-daemon-task', 'second-daemon-task', 'echo:second-daemon-task']);

    const logs = (await readFile(subLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(logs).toEqual(['first-daemon-task', 'second-daemon-task']);
  });

  it('真实 PipeTransport：send 正常完成且对应 Task completed，stop 证明退出且不留 blocker，stop→resume 继续第二轮', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-pipe-'));
    directories.push(dir);
    const subLog = join(dir, 'pipe-subs.jsonl');
    const { repos, runtime } = open(dir, join(dir, 'state.db'));
    const agent = agentConfigSchema.parse({
      id: 'pipe-agent', name: 'Pipe', command: process.execPath, args: [turnFixture],
      protocol: 'pipe', cwd: dir, env: { turn_agent_submission_log: subLog }, permissionMode: 'ask', timeout: 10,
      capabilities: { pause: false, resume: true }
    });
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: 'pipe-agent', cwd: dir });

    const task1 = await runtime.send(session.id, 'pipe-first');
    expect(task1.status).toBe('completed');
    expect((await runtime.getTasks(session.id)).map(t => t.status)).toEqual(['completed']);

    await runtime.stop(session.id);
    expect(runtime.getDriverStopBlock(session.id)).toBeUndefined();
    expect((await repos.config.get('runtime_driver_stop_block:' + session.id)) ?? '').toBe('');

    await runtime.resume(session.id);
    const task2 = await runtime.send(session.id, 'pipe-second');
    expect(task2.status).toBe('completed');
    expect((await runtime.getTasks(session.id)).map(t => t.status)).toEqual(['completed', 'completed']);

    const logs = (await readFile(subLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(logs).toEqual(['pipe-first', 'pipe-second']);
  });

  it('真实 process-tree fixture：证明 stop 彻底回收后代进程且不残留 stop blocker，后续可正常重建', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dutydeck-runtime-tree-'));
    directories.push(dir);
    const { repos, runtime } = open(dir, join(dir, 'state.db'));
    const pidFile = join(dir, 'child.pid');
    const agent = agentConfigSchema.parse({
      id: 'tree-agent', name: 'Tree', command: process.execPath, args: [processTreeFixture],
      protocol: 'jsonl', cwd: dir, env: { DUTYDECK_TEST_PID_FILE: pidFile }, permissionMode: 'ask', timeout: 10,
      capabilities: { pause: false, resume: true }
    });

    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: 'tree-agent', cwd: dir });
    let childPid = 0;
    await vi.waitFor(async () => {
      childPid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(childPid).toBeGreaterThan(0);
    });

    // 确认后代孙代进程真实存活
    expect(await pidGone(childPid)).toBe(false);

    // stop 必须成功 resolve，POSIX 进程组探针核验通过
    await runtime.stop(session.id);
    expect((await runtime.getSession(session.id))?.state).toBe('stopped');

    // 证明后代孙代进程被真实杀除
    await expect.poll(() => pidGone(childPid), { timeout: 5_000 }).toBe(true);

    // 证明内存和 SQLite 中均不残留 stop blocker
    expect(runtime.getDriverStopBlock(session.id)).toBeUndefined();
    expect((await repos.config.get('runtime_driver_stop_block:' + session.id)) ?? '').toBe('');

    // 证明后续可正常重建（restart 不被 blocker 阻断），并拉起新的独立后代进程
    await rm(pidFile, { force: true });
    const restarted = await runtime.restart(session.id);
    expect(restarted.runId).not.toBe(session.runId);

    let newChildPid = 0;
    await vi.waitFor(async () => {
      newChildPid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(newChildPid).toBeGreaterThan(0);
      expect(newChildPid).not.toBe(childPid);
    });
    expect(await pidGone(newChildPid)).toBe(false);

    // 最终清理
    await runtime.stop(session.id);
    await expect.poll(() => pidGone(newChildPid), { timeout: 5_000 }).toBe(true);
  });
});
