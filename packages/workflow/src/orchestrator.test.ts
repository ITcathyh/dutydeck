import { describe, expect, it } from 'vitest';
import { validateDag } from './dag.js';
import { decideNext, edgeKey, readinessFor } from './orchestrator.js';
import type { EdgeState, NodeState, NormalizedDag, RunSnapshot } from './types.js';

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, goal: `do ${id}`, ...extra });
const dagOf = (nodes: unknown[]) => validateDag({ runId: 'r', nodes });

/** 构造快照：只写关心的字段，其余取默认。 */
function snap(
  nodes: Record<string, Partial<NodeState> & { status: NodeState['status'] }> = {},
  edges: Record<string, boolean> = {},
  runStatus: RunSnapshot['runStatus'] = 'running',
): RunSnapshot {
  return {
    runId: 'r',
    runStatus,
    nodes: new Map(Object.entries(nodes).map(([id, s]) => [id, { attempts: 1, ...s }])),
    edges: new Map<string, EdgeState>(Object.entries(edges).map(([k, active]) => [k, { active }])),
    openGates: new Map(),
  };
}

const kinds = (dag: NormalizedDag, s: RunSnapshot) => decideNext(dag, s).map((a) => a.kind);
const dispatched = (dag: NormalizedDag, s: RunSnapshot) =>
  decideNext(dag, s).filter((a) => a.kind === 'dispatchWork').map((a) => (a as { nodeId: string }).nodeId);

describe('decideNext — 依赖顺序', () => {
  const chain = dagOf([node('a'), node('b', { depends: ['a'] }), node('c', { depends: ['b'] })]);

  it('起始只派发无依赖的节点', () => {
    expect(dispatched(chain, snap())).toEqual(['a']);
  });

  it('依赖未满足的节点不会被派发', () => {
    // a 在跑，b/c 都不该动
    expect(dispatched(chain, snap({ a: { status: 'running' } }))).toEqual([]);
  });

  it('上游 done 之后才轮到下游', () => {
    expect(dispatched(chain, snap({ a: { status: 'done' } }))).toEqual(['b']);
    expect(dispatched(chain, snap({ a: { status: 'done' }, b: { status: 'done' } }))).toEqual(['c']);
  });

  it('全部 done → run 成功', () => {
    const all = snap({ a: { status: 'done' }, b: { status: 'done' }, c: { status: 'done' } });
    expect(decideNext(chain, all)).toEqual([{ kind: 'completeRunSucceeded' }]);
  });

  it('已在跑的节点不会被重复派发', () => {
    const dag = dagOf([node('a'), node('b')]);
    expect(dispatched(dag, snap({ a: { status: 'running' } }))).toEqual(['b']);
  });
});

describe('decideNext — 并行分支', () => {
  const diamond = dagOf([
    node('root'),
    node('left', { depends: ['root'] }),
    node('right', { depends: ['root'] }),
    node('join', { depends: ['left', 'right'] }),
  ]);

  it('root 完成后两个分支同时可派发', () => {
    expect(dispatched(diamond, snap({ root: { status: 'done' } })).sort()).toEqual(['left', 'right']);
  });

  it('join 要等两个分支都完成（all_success 默认）', () => {
    const half = snap({ root: { status: 'done' }, left: { status: 'done' }, right: { status: 'running' } });
    expect(dispatched(diamond, half)).toEqual([]);
    const full = snap({ root: { status: 'done' }, left: { status: 'done' }, right: { status: 'done' } });
    expect(dispatched(diamond, full)).toEqual(['join']);
  });
});

describe('decideNext — triggerRule', () => {
  it('one_success：任意一个上游成功即可启动', () => {
    const dag = dagOf([
      node('a'),
      node('b'),
      node('join', { depends: ['a', 'b'], triggerRule: 'one_success' }),
    ]);
    expect(dispatched(dag, snap({ a: { status: 'done' }, b: { status: 'running' } }))).toEqual(['join']);
  });

  it('quorum：达到票数才启动', () => {
    const dag = dagOf([
      node('a'),
      node('b'),
      node('c'),
      node('join', { depends: ['a', 'b', 'c'], triggerRule: { quorum: 2 } }),
    ]);
    const one = snap({ a: { status: 'done' }, b: { status: 'running' }, c: { status: 'running' } });
    expect(dispatched(dag, one)).toEqual([]);
    const two = snap({ a: { status: 'done' }, b: { status: 'done' }, c: { status: 'running' } });
    expect(dispatched(dag, two)).toEqual(['join']);
  });

  it('剩余上游全成功也凑不够 → 判 skipped 而不是干等', () => {
    const dag = dagOf([
      node('a'),
      node('b'),
      node('c'),
      node('join', { depends: ['a', 'b', 'c'], triggerRule: { quorum: 3 } }),
    ]);
    // a 被 skip 掉，quorum 3 已不可能达成
    const actions = decideNext(dag, snap({ a: { status: 'skipped' }, b: { status: 'done' }, c: { status: 'done' } }));
    expect(actions).toEqual([
      { kind: 'skipNode', nodeId: 'join', detail: expect.stringContaining('unsatisfiable') },
    ]);
  });

  it('skipped 是可接受终态：只要 sink 还有产出，run 仍算成功', () => {
    const dag = dagOf([node('a'), node('b', { depends: ['a'], triggerRule: 'one_success' }), node('c')]);
    const s = snap({ a: { status: 'skipped' }, b: { status: 'skipped' }, c: { status: 'done' } });
    expect(decideNext(dag, s)).toEqual([{ kind: 'completeRunSucceeded' }]);
  });

  it('所有 sink 都被 skip → run 失败（这次 run 什么都没产出）', () => {
    const dag = dagOf([node('a'), node('b', { depends: ['a'] })]);
    const s = snap({ a: { status: 'skipped' }, b: { status: 'skipped' } });
    expect(decideNext(dag, s)).toEqual([{ kind: 'completeRunFailed', detail: 'allSinksSkipped' }]);
  });
});

describe('decideNext — 条件边', () => {
  const dag = dagOf([
    node('check'),
    node('deploy', { depends: [{ from: 'check', when: { key: 'ok', equals: true } }] }),
  ]);

  it('上游 done 但边未裁决 → 先出 resolveEdge，不直接派发', () => {
    // 边的结论必须先落 journal，否则重放时结论可能变，快照就不是事件的纯函数了
    expect(decideNext(dag, snap({ check: { status: 'done', outputs: { ok: true } } }))).toEqual([
      { kind: 'resolveEdge', from: 'check', to: 'deploy' },
    ]);
  });

  it('边裁决为激活 → 下游派发', () => {
    const s = snap({ check: { status: 'done', outputs: { ok: true } } }, { [edgeKey('check', 'deploy')]: true });
    expect(dispatched(dag, s)).toEqual(['deploy']);
  });

  it('边裁决为不激活 → 下游 skipped（all_success 下不可能再满足）', () => {
    const s = snap({ check: { status: 'done', outputs: { ok: false } } }, { [edgeKey('check', 'deploy')]: false });
    expect(kinds(dag, s)).toEqual(['skipNode']);
  });
});

describe('decideNext — 人工闸门', () => {
  const dag = dagOf([node('a', { humanGate: { prompt: '确认' } }), node('b', { depends: ['a'] })]);

  it('有闸门的节点先派发闸门而不是工作', () => {
    expect(decideNext(dag, snap())).toEqual([{ kind: 'dispatchGate', nodeId: 'a' }]);
  });

  it('gateWaiting 期间不重复派发', () => {
    expect(decideNext(dag, snap({ a: { status: 'gateWaiting' } }))).toEqual([]);
  });

  it('放行后（gateCleared）才派发真正的工作', () => {
    expect(decideNext(dag, snap({ a: { status: 'pending', gateCleared: true } }))).toEqual([
      { kind: 'dispatchWork', nodeId: 'a' },
    ]);
  });
});

describe('decideNext — 失败传播', () => {
  const dag = dagOf([node('a'), node('b'), node('c', { depends: ['a'] })]);

  it('任一节点 failed → fail-fast，不再派发任何工作', () => {
    expect(decideNext(dag, snap({ a: { status: 'failed' }, b: { status: 'pending' } }))).toEqual([
      { kind: 'completeRunFailed', failedNodeId: 'a' },
    ]);
  });

  it('blocked → run 停在 blocked（可重试），而不是 failed', () => {
    expect(decideNext(dag, snap({ a: { status: 'blocked' } }))).toEqual([
      { kind: 'completeRunBlocked', blockedNodeId: 'a' },
    ]);
  });

  it('failed 与 blocked 同时存在时 failed 优先（更严重、且不可自动恢复）', () => {
    expect(decideNext(dag, snap({ a: { status: 'blocked' }, b: { status: 'failed' } }))).toEqual([
      { kind: 'completeRunFailed', failedNodeId: 'b' },
    ]);
  });

  it('归因取拓扑序最早的节点，结果确定', () => {
    const s = snap({ a: { status: 'failed' }, b: { status: 'failed' } });
    expect(decideNext(dag, s)).toEqual([{ kind: 'completeRunFailed', failedNodeId: 'a' }]);
    expect(decideNext(dag, s)).toEqual(decideNext(dag, s));
  });
});

describe('readinessFor', () => {
  const dag = dagOf([node('a'), node('b'), node('j', { depends: ['a', 'b'] })]);
  const j = dag.nodes.find((n) => n.id === 'j')!;

  it('无依赖节点立即就绪', () => {
    expect(readinessFor(dag.nodes[0]!, snap()).kind).toBe('ready');
  });

  it('上游在跑 → wait', () => {
    expect(readinessFor(j, snap({ a: { status: 'done' }, b: { status: 'running' } })).kind).toBe('wait');
  });

  it('上游 failed 让 all_success 变得不可满足 → skip', () => {
    expect(readinessFor(j, snap({ a: { status: 'done' }, b: { status: 'failed' } })).kind).toBe('skip');
  });
});
