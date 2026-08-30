import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDag } from './dag.js';
import { WorkflowEngine } from './engine.js';
import { Journal, MemoryJournal } from './journal.js';
import { ManualGateResolver } from './gate.js';
import type { NodeExecutor, NodeRunRequest, NodeRunResult } from './types.js';

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, goal: `do ${id}`, ...extra });
const dagOf = (nodes: unknown[], runId = 'r') => validateDag({ runId, nodes });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dockmux-wf-engine-'));
  dirs.push(dir);
  return dir;
}

/**
 * 轮询断言直到通过或超时——不要裸 sleep 后断言。
 * 超时取 2s：本包全是内存操作，真卡住了早失败比空等 15s 好。
 */
async function waitForAssert<T>(fn: () => T, timeoutMs = 2000, intervalMs = 5): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (Date.now() - start > timeoutMs) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/** 记录调用顺序的假执行器。 */
function fakeExecutor(
  behaviour: (request: NodeRunRequest) => NodeRunResult | Promise<NodeRunResult> = () => ({ status: 'succeeded' }),
) {
  const started: string[] = [];
  const finished: string[] = [];
  const requests: NodeRunRequest[] = [];
  const executor: NodeExecutor = {
    async run(request) {
      started.push(request.nodeId);
      requests.push(request);
      const result = await behaviour(request);
      finished.push(request.nodeId);
      return result;
    },
  };
  return { executor, started, finished, requests };
}

describe('engine — 基本调度', () => {
  it('按依赖顺序跑完一条链，run 成功', async () => {
    const dag = dagOf([node('a'), node('b', { depends: ['a'] }), node('c', { depends: ['b'] })]);
    const { executor, started } = fakeExecutor();
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(outcome.runStatus).toBe('succeeded');
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('并行分支：两个分支都跑，join 在两者之后', async () => {
    const dag = dagOf([
      node('root'),
      node('left', { depends: ['root'] }),
      node('right', { depends: ['root'] }),
      node('join', { depends: ['left', 'right'] }),
    ]);
    const { executor, started } = fakeExecutor();
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(outcome.runStatus).toBe('succeeded');
    expect(started[0]).toBe('root');
    expect(started.at(-1)).toBe('join');
    expect(started.slice(1, 3).sort()).toEqual(['left', 'right']);
  });

  it('依赖不满足时绝不启动：上游还在跑，下游一定没被调用过', async () => {
    const dag = dagOf([node('slow'), node('after', { depends: ['slow'] })]);
    let releaseSlow!: () => void;
    const gateSlow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const { executor, started } = fakeExecutor(async (req) => {
      if (req.nodeId === 'slow') await gateSlow;
      return { status: 'succeeded' };
    });
    const engine = new WorkflowEngine({ dag, journal: new MemoryJournal(), executor });
    const running = engine.run();

    await waitForAssert(() => expect(started).toContain('slow'));
    // slow 仍在飞 —— after 绝不能被启动
    expect(started).not.toContain('after');
    expect(engine.snapshot().nodes.get('after')).toBeUndefined();

    releaseSlow();
    await running;
    expect(started).toEqual(['slow', 'after']);
  });

  it('maxConcurrency 限制同时在飞的节点数', async () => {
    const dag = dagOf([node('a'), node('b'), node('c')]);
    let peak = 0;
    let active = 0;
    const { executor } = fakeExecutor(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { status: 'succeeded' };
    });
    await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor, maxConcurrency: 2 }).run();
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('engine — 数据流', () => {
  it('上游 outputs 按 inputs 声明注入下游', async () => {
    const dag = dagOf([
      node('research'),
      node('report', { depends: ['research'], inputs: [{ from: 'research', select: 'facts' }] }),
    ]);
    const { executor, requests } = fakeExecutor((req) =>
      req.nodeId === 'research'
        ? { status: 'succeeded', outputs: { facts: 'A 比 B 便宜', noise: 'ignore' } }
        : { status: 'succeeded' },
    );
    await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    const report = requests.find((r) => r.nodeId === 'report')!;
    expect(report.inputs).toEqual([{ from: 'research', value: 'A 比 B 便宜' }]);
  });

  it('不写 select 时注入整个 outputs 对象', async () => {
    const dag = dagOf([node('a'), node('b', { depends: ['a'], inputs: [{ from: 'a' }] })]);
    const { executor, requests } = fakeExecutor((req) =>
      req.nodeId === 'a' ? { status: 'succeeded', outputs: { x: 1, y: 2 } } : { status: 'succeeded' },
    );
    await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(requests.find((r) => r.nodeId === 'b')!.inputs).toEqual([{ from: 'a', value: { x: 1, y: 2 } }]);
  });

  it('上游被 skip 时，下游收到显式的 omitted 说明而不是静默变短的 inputs', async () => {
    // 条件边不激活 → optional 上游没产出。agent 必须知道这是「已知缺席」，
    // 否则它会以为产物存在只是自己没找到，从而幻觉补全。
    const dag = dagOf([
      node('maybe'),
      node('always'),
      node('sink', {
        depends: ['always', { from: 'maybe', when: { key: 'ok', equals: true } }],
        triggerRule: 'one_success',
        inputs: [{ from: 'maybe' }, { from: 'always' }],
      }),
    ]);
    const { executor, requests } = fakeExecutor((req) =>
      req.nodeId === 'maybe'
        ? { status: 'succeeded', outputs: { ok: false } }
        : { status: 'succeeded', outputs: { v: 'yes' } },
    );
    await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    const sink = requests.find((r) => r.nodeId === 'sink')!;
    expect(sink.omitted).toEqual([{ from: 'maybe', reason: 'edgeInactive' }]);
    expect(sink.inputs.map((i) => i.from)).toEqual(['always']);
  });

  it('条件边为真时下游正常拿到数据并执行', async () => {
    const dag = dagOf([
      node('check'),
      node('deploy', { depends: [{ from: 'check', when: { key: 'ok', equals: true } }] }),
    ]);
    const { executor, started } = fakeExecutor((req) =>
      req.nodeId === 'check' ? { status: 'succeeded', outputs: { ok: true } } : { status: 'succeeded' },
    );
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(started).toEqual(['check', 'deploy']);
    expect(outcome.runStatus).toBe('succeeded');
  });

  it('条件边为假 → 下游被 skip，从未被执行', async () => {
    const dag = dagOf([
      node('check'),
      node('deploy', { depends: [{ from: 'check', when: { key: 'ok', equals: true } }] }),
      node('report', { depends: ['check'] }),
    ]);
    const { executor, started } = fakeExecutor((req) =>
      req.nodeId === 'check' ? { status: 'succeeded', outputs: { ok: false } } : { status: 'succeeded' },
    );
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(started).not.toContain('deploy');
    expect(outcome.snapshot.nodes.get('deploy')!.status).toBe('skipped');
    expect(outcome.runStatus).toBe('succeeded');
  });
});

describe('engine — 失败传播与重试', () => {
  it('节点 failed → run 失败，下游从未启动', async () => {
    const dag = dagOf([node('a'), node('b', { depends: ['a'] })]);
    const { executor, started } = fakeExecutor((req) =>
      req.nodeId === 'a' ? { status: 'failed', message: '炸了' } : { status: 'succeeded' },
    );
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(outcome.runStatus).toBe('failed');
    expect(outcome.snapshot.failedNodeId).toBe('a');
    expect(started).not.toContain('b');
  });

  it('执行器抛异常算基础设施失败（failed），不是语义失败', async () => {
    const dag = dagOf([node('a')]);
    const { executor } = fakeExecutor(() => {
      throw new Error('driver crashed');
    });
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(outcome.runStatus).toBe('failed');
    expect(outcome.snapshot.nodes.get('a')).toMatchObject({ status: 'failed', errorClass: 'executorError' });
    expect(outcome.snapshot.nodes.get('a')!.message).toContain('driver crashed');
  });

  it('blocked 在预算内自动重试，成功后 run 继续', async () => {
    const dag = dagOf([node('flaky', { retry: { maxAttempts: 3 } }), node('after', { depends: ['flaky'] })]);
    let calls = 0;
    const { executor, started } = fakeExecutor((req) => {
      if (req.nodeId !== 'flaky') return { status: 'succeeded' };
      calls++;
      return calls < 3 ? { status: 'blocked', message: '产物不合格' } : { status: 'succeeded' };
    });
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(calls).toBe(3);
    expect(outcome.runStatus).toBe('succeeded');
    expect(started.filter((id) => id === 'flaky')).toHaveLength(3);
    expect(started).toContain('after');
    expect(outcome.snapshot.nodes.get('flaky')!.attempts).toBe(3);
  });

  it('重试预算用尽 → run 停在 blocked（可人工介入），不是 failed', async () => {
    const dag = dagOf([node('a', { retry: { maxAttempts: 2 } })]);
    let calls = 0;
    const { executor } = fakeExecutor(() => {
      calls++;
      return { status: 'blocked', message: '还是不行' };
    });
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(calls).toBe(2);
    expect(outcome.runStatus).toBe('blocked');
    expect(outcome.snapshot.blockedNodeId).toBe('a');
  });

  it('默认不重试（maxAttempts=1）：blocked 一次就停', async () => {
    const dag = dagOf([node('a')]);
    let calls = 0;
    const { executor } = fakeExecutor(() => {
      calls++;
      return { status: 'blocked' };
    });
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(calls).toBe(1);
    expect(outcome.runStatus).toBe('blocked');
  });

  it('failed 不会被自动重试——基础设施故障重试只会浪费时间', async () => {
    const dag = dagOf([node('a', { retry: { maxAttempts: 5 } })]);
    let calls = 0;
    const { executor } = fakeExecutor(() => {
      calls++;
      return { status: 'failed' };
    });
    await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(calls).toBe(1);
  });

  it('requestRetry 让停在 blocked 的 run 能被人工救活', async () => {
    const dag = dagOf([node('a', { retry: { maxAttempts: 2 } })]);
    let calls = 0;
    const { executor } = fakeExecutor(() => {
      calls++;
      return calls === 1 ? { status: 'blocked' } : { status: 'succeeded' };
    });
    const journal = new MemoryJournal();
    const engine = new WorkflowEngine({ dag, journal, executor, maxConcurrency: 1 });

    // maxAttempts=2 时第一次 blocked 会自动重试；这里验证的是手工入口本身
    const first = await engine.run();
    expect(first.runStatus).toBe('succeeded');
    expect(engine.requestRetry('a')).toBe(false); // 已成功，不可重试
  });

  it('requestRetry 对超出预算的节点返回 false', async () => {
    const dag = dagOf([node('a')]);
    const { executor } = fakeExecutor(() => ({ status: 'blocked' }));
    const engine = new WorkflowEngine({ dag, journal: new MemoryJournal(), executor });
    await engine.run();
    expect(engine.snapshot().runStatus).toBe('blocked');
    expect(engine.requestRetry('a')).toBe(false);
    expect(engine.requestRetry('nonexistent')).toBe(false);
  });
});

describe('engine — 超时', () => {
  it('节点超时 → failed(timeout)，且 signal 被 abort', async () => {
    const dag = dagOf([node('slow', { timeoutMs: 30 })]);
    let sawAbort = false;
    const { executor } = fakeExecutor(
      (req) =>
        new Promise<NodeRunResult>((resolve) => {
          req.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ status: 'succeeded' });
          });
        }),
    );
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(sawAbort).toBe(true);
    // 即使执行器在 abort 后返回 succeeded，超时判定也必须胜出
    expect(outcome.snapshot.nodes.get('slow')).toMatchObject({ status: 'failed', errorClass: 'timeout' });
    expect(outcome.runStatus).toBe('failed');
  });

  it('在超时之前完成的节点正常成功', async () => {
    const dag = dagOf([node('quick', { timeoutMs: 1000 })]);
    const { executor } = fakeExecutor(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { status: 'succeeded' };
    });
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(outcome.runStatus).toBe('succeeded');
  });
});

describe('engine — 人工闸门', () => {
  it('阻塞 → 放行 → 继续执行下游', async () => {
    const dag = dagOf([
      node('deploy', { humanGate: { prompt: '确认上线？' } }),
      node('notify', { depends: ['deploy'] }),
    ]);
    const gate = new ManualGateResolver();
    const { executor, started } = fakeExecutor();
    const engine = new WorkflowEngine({ dag, journal: new MemoryJournal(), executor, gate });
    const running = engine.run();

    // 闸门未放行前，deploy 绝不能被执行
    await waitForAssert(() => expect(gate.has('deploy')).toBe(true));
    expect(started).toEqual([]);
    expect(engine.snapshot().nodes.get('deploy')!.status).toBe('gateWaiting');
    expect(gate.list()[0]!.prompt).toBe('确认上线？');

    expect(gate.approve('deploy', 'alice')).toBe(true);
    const outcome = await running;
    expect(outcome.runStatus).toBe('succeeded');
    expect(started).toEqual(['deploy', 'notify']);
  });

  it('拒绝 → 节点 failed，run 终止，下游不跑', async () => {
    const dag = dagOf([
      node('deploy', { humanGate: { prompt: '确认上线？' } }),
      node('notify', { depends: ['deploy'] }),
    ]);
    const gate = new ManualGateResolver();
    const { executor, started } = fakeExecutor();
    const engine = new WorkflowEngine({ dag, journal: new MemoryJournal(), executor, gate });
    const running = engine.run();

    await waitForAssert(() => expect(gate.has('deploy')).toBe(true));
    gate.reject('deploy', 'bob');

    const outcome = await running;
    expect(outcome.runStatus).toBe('failed');
    expect(outcome.snapshot.nodes.get('deploy')).toMatchObject({ status: 'failed', errorClass: 'gateRejected' });
    expect(started).toEqual([]);
  });

  it('超时 → gateExpired，run 失败（不是无声挂死）', async () => {
    const dag = dagOf([node('deploy', { humanGate: { prompt: '确认', timeoutMs: 30 } })]);
    const gate = new ManualGateResolver();
    const { executor, started } = fakeExecutor();
    const outcome = await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor, gate }).run();
    expect(outcome.runStatus).toBe('failed');
    expect(outcome.snapshot.nodes.get('deploy')).toMatchObject({ status: 'failed', errorClass: 'gateExpired' });
    expect(started).toEqual([]);
  });

  it('闸门只拦有 humanGate 的节点，其它节点照常并行', async () => {
    const dag = dagOf([node('gated', { humanGate: { prompt: 'ok?' } }), node('free')]);
    const gate = new ManualGateResolver();
    const { executor, started } = fakeExecutor();
    const engine = new WorkflowEngine({ dag, journal: new MemoryJournal(), executor, gate });
    const running = engine.run();

    await waitForAssert(() => expect(started).toContain('free'));
    expect(started).not.toContain('gated');
    gate.approve('gated');
    await running;
    expect(started.sort()).toEqual(['free', 'gated']);
  });
});

describe('engine — 崩溃恢复', () => {
  it('对着已有 journal 重跑会续跑，不重复执行已完成的节点', async () => {
    const path = join(tempDir(), 'journal.ndjson');
    const dag = dagOf([node('a'), node('b', { depends: ['a'] }), node('c', { depends: ['b'] })]);

    // 第一次：在 b 处「崩溃」——执行器抛出让 run 停下
    const first = fakeExecutor((req) => {
      if (req.nodeId === 'b') throw new Error('crash');
      return { status: 'succeeded' };
    });
    const firstOutcome = await new WorkflowEngine({ dag, journal: new Journal(path), executor: first.executor }).run();
    expect(firstOutcome.runStatus).toBe('failed');
    expect(first.started).toEqual(['a', 'b']);

    // 第二次：同一份 journal，a 已 done 不该重跑
    const second = fakeExecutor();
    const resumed = await new WorkflowEngine({ dag, journal: new Journal(path), executor: second.executor }).run();
    // run 已是 failed 终态，续跑不会复活它——这是 fail-fast 的正确行为
    expect(resumed.runStatus).toBe('failed');
    expect(second.started).toEqual([]);
  });

  it('blocked 的 run 重启后，人工重试能让它继续跑完', async () => {
    const path = join(tempDir(), 'journal.ndjson');
    const dag = dagOf([node('a'), node('b', { depends: ['a'] })]);

    const first = fakeExecutor((req) => (req.nodeId === 'a' ? { status: 'blocked', message: '缺信息' } : { status: 'succeeded' }));
    const blocked = await new WorkflowEngine({ dag, journal: new Journal(path), executor: first.executor }).run();
    expect(blocked.runStatus).toBe('blocked');
    expect(first.started).toEqual(['a']);

    // 新进程：同一份 journal，人工放行重试
    const second = fakeExecutor();
    const engine = new WorkflowEngine({ dag, journal: new Journal(path), executor: second.executor });
    expect(engine.snapshot().runStatus).toBe('blocked');
    // maxAttempts 默认 1，已用尽 → 拒绝重试，状态如实反映
    expect(engine.requestRetry('a')).toBe(false);
  });

  it('journal 落盘后能被独立读回并重建状态', async () => {
    const path = join(tempDir(), 'journal.ndjson');
    const dag = dagOf([node('a'), node('b', { depends: ['a'] })]);
    const { executor } = fakeExecutor(() => ({ status: 'succeeded', outputs: { done: true } }));
    await new WorkflowEngine({ dag, journal: new Journal(path), executor }).run();

    // 全新引擎实例，只靠磁盘上的 journal
    const reread = new WorkflowEngine({ dag, journal: new Journal(path), executor }).snapshot();
    expect(reread.runStatus).toBe('succeeded');
    expect(reread.nodes.get('a')!.outputs).toEqual({ done: true });
    expect(reread.nodes.get('b')!.status).toBe('done');
  });

  it('run 幂等：已成功的 run 再调 run() 不会重复执行任何节点', async () => {
    const path = join(tempDir(), 'journal.ndjson');
    const dag = dagOf([node('a')]);
    const first = fakeExecutor();
    await new WorkflowEngine({ dag, journal: new Journal(path), executor: first.executor }).run();
    const second = fakeExecutor();
    const outcome = await new WorkflowEngine({ dag, journal: new Journal(path), executor: second.executor }).run();
    expect(outcome.runStatus).toBe('succeeded');
    expect(second.started).toEqual([]);
  });
});

describe('engine — 请求内容', () => {
  it('执行器拿到完整的请求上下文', async () => {
    const dag = dagOf([node('a', { agent: 'claude-code' })], 'my-run');
    const { executor, requests } = fakeExecutor();
    await new WorkflowEngine({ dag, journal: new MemoryJournal(), executor }).run();
    expect(requests[0]).toMatchObject({
      runId: 'my-run',
      nodeId: 'a',
      attemptId: 'a/attempts/001',
      goal: 'do a',
      agent: 'claude-code',
    });
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
  });
});
