import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig, AgentEvent } from '@dutydeck/shared';
import { DutydeckRuntime, type AgentDriver } from './index.js';

const agent: AgentConfig = {
  id: 'mock',
  name: 'Mock',
  command: process.execPath,
  args: [],
  protocol: 'acp',
  cwd: '/tmp',
  env: {},
  permissionMode: 'ask',
  timeout: 10,
  capabilities: { pause: false, resume: true },
  builtin: false
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function harness(options: {
  onSend?: (emit: (event: any) => void) => void;
  driverIdleTimeoutMs?: number;
} = {}) {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  let emit!: (event: any) => void;
  let exit!: (code: number | null) => void;
  // Capture the bound execution repository so event-write fault injection sits
  // at the real ledger command boundary (publishSessionEvent now appends via
  // bound().appendEvent rather than the legacy repositories.events.append).
  let bound: ReturnType<typeof repos.execution.bind> | undefined;
  const bind = repos.execution.bind.bind(repos.execution);
  vi.spyOn(repos.execution, 'bind').mockImplementation(claim => { bound = bind(claim); return bound; });
  const driver: AgentDriver = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {
      options.onSend?.(emit);
      emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    }),
    interrupt: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    isStopped: async () => true, stop: vi.fn(async () => {}),
    resolvePermission: vi.fn(async () => true),
    setModel: vi.fn(async () => {}),
    setReasoningEffort: vi.fn(async () => {}),
    setPermissionMode: vi.fn()
  };
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (_configuredAgent, _p, onEvent, onExit) => {
      emit = onEvent;
      exit = onExit;
      return driver;
    },
    driverIdleTimeoutMs: options.driverIdleTimeoutMs
  });
  return {
    repos,
    runtime,
    driver,
    bound: () => bound!,
    emitDriverEvent: (event: any) => emit(event),
    exit: (code: number | null) => exit(code)
  };
}

describe('session event sequence & concurrency regression', () => {
  it('cold session without history: concurrent publishSessionEvent calls do not conflict on sequence UNIQUE constraint', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);

    // Use bound execution to create a true zero-history Session (no startup status
    // events appended) to verify the cold sequence allocation from a true zero HWM.
    const coldSessionId = 'ses_cold_no_history';
    const timestamp = new Date().toISOString();
    h.bound().createSession({
      id: coldSessionId,
      agentId: 'mock',
      state: 'idle',
      cwd: '/tmp',
      workspaceMode: 'shared',
      permissionMode: 'ask',
      protocol: 'acp',
      runId: 'run_cold_mock',
      createdAt: timestamp,
      updatedAt: timestamp
    });

    // 并发发起 10 个带外 public 事件
    const concurrency = 10;
    const promises = Array.from({ length: concurrency }, (_, index) =>
      h.runtime.publishSessionEvent(coldSessionId, 'text', { text: `concurrent-msg-${index}`, index })
    );

    const published = await Promise.all(promises);
    expect(published).toHaveLength(concurrency);

    const storedEvents = await h.runtime.getEvents(coldSessionId);
    const publicEvents = storedEvents.filter(e => (e.data as any)?.text?.startsWith('concurrent-msg-'));
    expect(publicEvents).toHaveLength(concurrency);

    const sequences = publicEvents.map(e => e.sequence);
    const uniqueSequences = new Set(sequences);
    expect(uniqueSequences.size).toBe(concurrency);

    // sequences 应当严格递增且不重复
    const sorted = [...sequences].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1]! + 1);
    }

    await h.runtime.shutdown();
    h.repos.close();
  });

  it('cold session with existing history: concurrent publishSessionEvent calls read correct next sequence without collision', async () => {
    const h = harness({
      onSend: emit => {
        emit({ type: 'text', data: { text: 'historical-1' } });
        emit({ type: 'text', data: { text: 'historical-2' } });
      }
    });
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });
    await h.runtime.send(session.id, 'historical prompt');

    await h.runtime.shutdown();
    // 验证已有历史事件已落库
    const beforeEvents = await h.runtime.getEvents(session.id);
    const maxBeforeSequence = Math.max(...beforeEvents.map(e => e.sequence));
    expect(maxBeforeSequence).toBeGreaterThan(0);

    // 用同一个真实 SQLite 仓库创建全新的 runtime 实例，模拟重启或冷缓存命中
    const coldRuntime = new DutydeckRuntime(h.repos, {
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: () => h.driver
    });

    await coldRuntime.initialize([agent]);
    // 并发发起 8 个带外 public 事件
    const concurrency = 8;
    const promises = Array.from({ length: concurrency }, (_, index) =>
      coldRuntime.publishSessionEvent(session.id, 'text', { text: `cold-with-history-${index}` })
    );

    const published = await Promise.all(promises);
    expect(published).toHaveLength(concurrency);

    const afterEvents = await coldRuntime.getEvents(session.id);
    const newEvents = afterEvents.filter(e => (e.data as any)?.text?.startsWith('cold-with-history-'));
    expect(newEvents).toHaveLength(concurrency);

    const newSequences = newEvents.map(e => e.sequence).sort((a, b) => a - b);
    expect(new Set(newSequences).size).toBe(concurrency);
    expect(newSequences[0]).toBe(maxBeforeSequence + 1);
    for (let i = 1; i < newSequences.length; i++) {
      expect(newSequences[i]).toBe(newSequences[i - 1]! + 1);
    }

    await coldRuntime.shutdown();
    await h.runtime.shutdown();
    h.repos.close();
  });

  it('mixed driver and public events maintain strict ordering and sequence uniqueness', async () => {
    let emitDriverEvent!: (event: any) => void;
    const turnBusyGate = deferred();
    const h = harness({
      onSend: emit => {
        emitDriverEvent = emit;
      }
    });
    // 用 deferred 保持 driver.send 真正处于 busy 状态
    h.driver.send = vi.fn(async () => {
      await turnBusyGate.promise;
    });

    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    const received: AgentEvent[] = [];
    const unsubscribe = h.runtime.subscribe(session.id, e => { received.push(e); });

    // 启动轮次（因 turnBusyGate 保持 busy）
    const turnPromise = h.runtime.send(session.id, 'prompt');
    await vi.waitFor(() => expect(h.driver.send).toHaveBeenCalled());

    // 顺序交替派发指定的 5 条事件：3 条 driver，2 条 public
    h.emitDriverEvent({ type: 'thinking', data: { text: 'thinking-1' } });
    const public1 = await h.runtime.publishSessionEvent(session.id, 'text', { text: 'public-1' });
    h.emitDriverEvent({ type: 'text', data: { text: 'driver-text-1' } });
    const public2 = await h.runtime.publishSessionEvent(session.id, 'text', { text: 'public-2' });
    h.emitDriverEvent({ type: 'text', data: { text: 'driver-final' } });

    // 释放 driver.send 完成轮次，等待 driver 事件完全消费（包含 flushDriverEvents）
    turnBusyGate.resolve();
    await turnPromise;
    unsubscribe();

    const expectedTexts = ['thinking-1', 'public-1', 'driver-text-1', 'public-2', 'driver-final'];

    // 1. 断言指定 5 条消息全部落库（一条不少）
    const storedEvents = await h.runtime.getEvents(session.id);
    const storedTargetEvents = storedEvents.filter(e => expectedTexts.includes((e.data as any)?.text));
    expect(storedTargetEvents).toHaveLength(5);
    expect(new Set(storedTargetEvents.map(e => (e.data as any)?.text))).toEqual(new Set(expectedTexts));

    // 2. 断言指定 5 条消息全部被广播（一条不少）
    const receivedTargetEvents = received.filter(e => expectedTexts.includes((e.data as any)?.text));
    expect(receivedTargetEvents).toHaveLength(5);
    expect(new Set(receivedTargetEvents.map(e => (e.data as any)?.text))).toEqual(new Set(expectedTexts));

    // 3. 广播与对应持久记录顺序完全相同
    expect(receivedTargetEvents.map(e => (e.data as any)?.text)).toEqual(
      storedTargetEvents.map(e => (e.data as any)?.text)
    );
    for (let i = 0; i < 5; i++) {
      expect(receivedTargetEvents[i]!.sequence).toBe(storedTargetEvents[i]!.sequence);
      expect(receivedTargetEvents[i]!.id).toBe(storedTargetEvents[i]!.id);
    }

    // 存储的 sequence 必须严格连续单调递增且不重复
    const storedSequences = storedEvents.map(e => e.sequence);
    expect(new Set(storedSequences).size).toBe(storedSequences.length);
    for (let i = 1; i < storedSequences.length; i++) {
      expect(storedSequences[i]).toBe(storedSequences[i - 1]! + 1);
    }

    await h.runtime.shutdown();
    h.repos.close();
  });

  it('append failure rejects the caller, does not poison future sequence, and emits no phantom SSE', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    const received: AgentEvent[] = [];
    const unsubscribe = h.runtime.subscribe(session.id, e => { received.push(e); });

    // 先正常写入一个事件
    const first = await h.runtime.publishSessionEvent(session.id, 'text', { text: 'success-1' });
    expect(first.sequence).toBeGreaterThan(0);

    // Inject a one-shot failure at the real ledger boundary: the bound
    // appendEvent command throws inside its BEGIN IMMEDIATE transaction, so no
    // sequence is consumed and no completion event is published.
    const execution = h.bound();
    const realAppendEvent = execution.appendEvent.bind(execution);
    let injectFailure = true;
    vi.spyOn(execution, 'appendEvent').mockImplementation((fence, event) => {
      if (injectFailure && (event.data as any)?.text === 'fail-msg') {
        injectFailure = false;
        throw new Error('SQLite disk I/O error');
      }
      return realAppendEvent(fence, event);
    });

    // 这次写入应当被拒绝，向调用者报错
    await expect(
      h.runtime.publishSessionEvent(session.id, 'text', { text: 'fail-msg' })
    ).rejects.toThrow('SQLite disk I/O error');

    // 验证订阅者没有收到这个失败事件（无 phantom SSE）
    expect(received.some(e => (e.data as any)?.text === 'fail-msg')).toBe(false);

    // 下一次写入应当能成功，且序号紧接上一个成功事件，不跳号、不被毒化
    const next = await h.runtime.publishSessionEvent(session.id, 'text', { text: 'success-2' });
    expect(next.sequence).toBe(first.sequence + 1);

    const storedEvents = await h.runtime.getEvents(session.id);
    expect(storedEvents.some(e => (e.data as any)?.text === 'fail-msg')).toBe(false);
    expect(storedEvents.find(e => (e.data as any)?.text === 'success-2')?.sequence).toBe(first.sequence + 1);

    unsubscribe();
    await h.runtime.shutdown();
    h.repos.close();
  });

  it('independent sessions do not block each other concurrently', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const sessionA = await h.runtime.start({ agentId: 'mock' });
    const sessionB = await h.runtime.start({ agentId: 'mock' });

    const gateA = deferred();
    const realSessionGet = h.repos.sessions.get.bind(h.repos.sessions);

    // Hold session A inside publishSessionEvent's real read boundary. Session B
    // uses an independent mutation scope and must not wait on A.
    h.repos.sessions.get = vi.fn(async (id: string) => {
      if (id === sessionA.id) {
        await gateA.promise;
      }
      return realSessionGet(id);
    });

    // 触发 sessionA 的写操作（被 gateA 挂起）
    let sessionACompleted = false;
    const promiseA = h.runtime.publishSessionEvent(sessionA.id, 'text', { text: 'slow-a' })
      .then(res => { sessionACompleted = true; return res; });

    // 等待确认 sessionA 的读取已被调用并挂起
    await vi.waitFor(() => {
      expect(h.repos.sessions.get).toHaveBeenCalledWith(sessionA.id);
    });
    expect(sessionACompleted).toBe(false);

    // 在 sessionA 挂起期间，sessionB 的写操作应当立即完成，不受 sessionA 阻塞
    const eventB = await h.runtime.publishSessionEvent(sessionB.id, 'text', { text: 'fast-b' });
    expect(eventB).toBeDefined();
    expect(eventB.sessionId).toBe(sessionB.id);
    expect(sessionACompleted).toBe(false);

    // 释放 sessionA
    gateA.resolve();
    const eventA = await promiseA;
    expect(eventA).toBeDefined();
    expect(eventA.sessionId).toBe(sessionA.id);

    await h.runtime.shutdown();
    h.repos.close();
  });

  it('stop during a pending event write keeps the event and does not collide sequences', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    // Hold the public event inside its real write tail: publishSessionEvent
    // reads the session once, then emit's bound write reads it again before
    // appendEvent. Block that second read.
    const gate = deferred();
    const realSessionGet = h.repos.sessions.get.bind(h.repos.sessions);
    let reads = 0;
    h.repos.sessions.get = vi.fn(async (id: string) => {
      const value = await realSessionGet(id);
      if (id === session.id && ++reads === 2) await gate.promise;
      return value;
    });

    let publicCompleted = false;
    const publicPromise = h.runtime.publishSessionEvent(session.id, 'text', { text: 'pending-before-stop' })
      .then(res => { publicCompleted = true; return res; });

    await vi.waitFor(() => expect(reads).toBe(2));
    expect(publicCompleted).toBe(false);

    const stopPromise = h.runtime.stop(session.id);
    // Give stop a tick to queue behind the in-flight write tail.
    await new Promise(resolve => setImmediate(resolve));
    expect(publicCompleted).toBe(false);

    gate.resolve();
    await publicPromise;
    await stopPromise;

    // The pending event committed exactly once with unique, contiguous
    // sequences, followed by the stopped status event.
    const events = await h.runtime.getEvents(session.id);
    const sequences = events.map(e => e.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1);
    }
    expect(events.some(e => (e.data as any)?.text === 'pending-before-stop')).toBe(true);
    expect(events.some(e => e.type === 'status' && (e.data as any)?.state === 'stopped')).toBe(true);

    await h.runtime.shutdown();
    h.repos.close();
  });

  it('shutdown waits for an in-flight emit chain instead of truncating the append', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    // Hold the event inside emit's bound write tail (the second session read
    // for this publish: the first read is publishSessionEvent's own lookup).
    const gate = deferred();
    const realSessionGet = h.repos.sessions.get.bind(h.repos.sessions);
    let reads = 0; let armed = true;
    h.repos.sessions.get = vi.fn(async (id: string) => {
      const value = await realSessionGet(id);
      if (armed && id === session.id && ++reads === 2) await gate.promise;
      return value;
    });

    const publicPromise = h.runtime.publishSessionEvent(session.id, 'text', { text: 'in-flight-on-shutdown' });
    await vi.waitFor(() => expect(reads).toBe(2));

    let shutdownFinished = false;
    const shutdownPromise = h.runtime.shutdown().then(() => { shutdownFinished = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(shutdownFinished).toBe(false);

    gate.resolve();
    await Promise.race([
      Promise.all([publicPromise, shutdownPromise]).then(() => 'settled' as const),
      new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 5_000))
    ]).then(outcome => expect(outcome).toBe('settled'));
    armed = false;
    expect(shutdownFinished).toBe(true);

    const events = await h.repos.events.list(session.id);
    expect(events.some(e => (e.data as any)?.text === 'in-flight-on-shutdown')).toBe(true);

    h.repos.close();
  });

  it('shutdown race: trailing publishSessionEvent rejected with RUNTIME_SHUTTING_DOWN on post-query check instead of leaking to closed db', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    const gateA = deferred();
    const gateB = deferred();

    // Event A is held inside emit's bound write tail (its 2nd session read);
    // event B is held at publishSessionEvent's first lookup read (the 3rd
    // overall read), before it reaches the post-query shuttingDown check.
    const realSessionGet = h.repos.sessions.get.bind(h.repos.sessions);
    let reads = 0;
    h.repos.sessions.get = vi.fn(async (id: string) => {
      const value = await realSessionGet(id);
      if (id === session.id) {
        reads++;
        if (reads === 2) await gateA.promise;
        else if (reads === 3) await gateB.promise;
      }
      return value;
    });

    // 1. 发起事件 A，停在 emit 写尾（第二次读取）
    const promiseA = h.runtime.publishSessionEvent(session.id, 'text', { text: 'event-A' });
    await vi.waitFor(() => expect(reads).toBe(2));

    // 2. 发起事件 B，停在入口查询（第三次读取）
    const promiseB = h.runtime.publishSessionEvent(session.id, 'text', { text: 'event-B' });
    await vi.waitFor(() => expect(reads).toBe(3));

    // 3. 启动 shutdown（A 已在写尾，B 的查询尚未返回复核 shuttingDown）
    const shutdownPromise = h.runtime.shutdown();

    // 4. 恢复事件 B 的查询：post-query 复核拒绝它
    gateB.resolve();
    await expect(promiseB).rejects.toMatchObject({
      code: 'RUNTIME_SHUTTING_DOWN',
      statusCode: 503
    });

    // 5. 释放事件 A 的写尾：在途事件仍完整落库
    gateA.resolve();
    await promiseA;
    await shutdownPromise;

    // shutdown 完成后再次调用立即被拒绝
    await expect(
      h.runtime.publishSessionEvent(session.id, 'text', { text: 'after-shutdown' })
    ).rejects.toMatchObject({
      code: 'RUNTIME_SHUTTING_DOWN',
      statusCode: 503
    });

    // shutdown 之后关闭 repos，不会发生未捕获的 closed db 错误
    h.repos.close();
  });

  it('shutdown loops waiting for all queued emitChains until completely empty', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock' });

    // Event 1 is held inside emit's bound write tail (its 2nd session read).
    // Event 2 completes its entry lookup and queues behind that same serialized
    // write tail (the 3rd read) before shutdown begins.
    const gate1 = deferred();
    const realSessionGet = h.repos.sessions.get.bind(h.repos.sessions);
    let reads = 0;
    h.repos.sessions.get = vi.fn(async (id: string) => {
      const value = await realSessionGet(id);
      if (id === session.id) { reads++; if (reads === 2) await gate1.promise; }
      return value;
    });

    const p1 = h.runtime.publishSessionEvent(session.id, 'text', { text: 'queued-1' });
    await vi.waitFor(() => expect(reads).toBe(2));
    const p2 = h.runtime.publishSessionEvent(session.id, 'text', { text: 'queued-2' });
    await vi.waitFor(() => expect(reads).toBe(3));

    // shutdown 必须排空已进入写尾队列的两条事件后才完成
    let shutdownDone = false;
    const shutdownPromise = h.runtime.shutdown().then(() => { shutdownDone = true; });
    expect((h.runtime as any).shuttingDown).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(shutdownDone).toBe(false);

    gate1.resolve();
    await Promise.all([p1, p2]);
    await shutdownPromise;
    expect(shutdownDone).toBe(true);

    const stored = await h.repos.events.list(session.id);
    expect(stored.some(e => (e.data as any)?.text === 'queued-1')).toBe(true);
    expect(stored.some(e => (e.data as any)?.text === 'queued-2')).toBe(true);

    h.repos.close();
  });
});
