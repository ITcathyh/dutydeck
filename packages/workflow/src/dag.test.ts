import { describe, expect, it } from 'vitest';
import {
  DagValidationError,
  evaluateEdgePredicate,
  findCycle,
  findSinks,
  topologicalOrder,
  validateDag,
} from './dag.js';

const dagOf = (nodes: unknown[], runId = 'r') => validateDag({ runId, nodes });
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, goal: `do ${id}`, ...extra });

/** 断言校验失败，并返回问题列表供进一步断言。 */
function problemsOf(raw: unknown): string[] {
  try {
    validateDag(raw);
  } catch (err) {
    if (err instanceof DagValidationError) return err.problems;
    throw err;
  }
  throw new Error('expected validateDag to throw DagValidationError');
}

describe('validateDag — 结构校验', () => {
  it('归一化：depends 的字符串与对象两种写法等价，默认值被填上', () => {
    const dag = dagOf([node('a'), node('b', { depends: ['a'] }), node('c', { depends: [{ from: 'a' }] })]);
    expect(dag.nodes[1]!.depends).toEqual([{ from: 'a' }]);
    expect(dag.nodes[2]!.depends).toEqual([{ from: 'a' }]);
    // 默认值：不重试、全部上游成功才启动
    expect(dag.nodes[0]!.maxAttempts).toBe(1);
    expect(dag.nodes[0]!.triggerRule).toBe('all_success');
    expect(dag.nodes[0]!.inputs).toEqual([]);
  });

  it('累积所有问题一次抛出，而不是遇到第一个就停', () => {
    const problems = problemsOf({
      runId: 'r',
      nodes: [node('a', { depends: ['ghost'] }), node('b', { goal: '' }), node('c', { triggerRule: 'nope' })],
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.some((p) => p.includes('unknown node "ghost"'))).toBe(true);
    expect(problems.some((p) => p.includes('"b".goal'))).toBe(true);
    expect(problems.some((p) => p.includes('"c".triggerRule'))).toBe(true);
  });

  it('拒绝重复 id', () => {
    expect(problemsOf({ runId: 'r', nodes: [node('a'), node('a')] })).toContain('duplicate node id "a"');
  });

  it('拒绝自依赖', () => {
    expect(problemsOf({ runId: 'r', nodes: [node('a', { depends: ['a'] })] })).toContain(
      'node "a" depends on itself',
    );
  });

  it('拒绝同一对 (from,to) 的重复边——它是 edgeResolved 的幂等键', () => {
    expect(
      problemsOf({ runId: 'r', nodes: [node('a'), node('b', { depends: ['a', 'a'] })] }),
    ).toContain('node "b".depends has duplicate entry "a"');
  });

  it('拒绝未知的 depends 引用', () => {
    expect(problemsOf({ runId: 'r', nodes: [node('a', { depends: ['nope'] })] })).toContain(
      'node "a" depends on unknown node "nope"',
    );
  });

  it('inputs 引用的上游必须同时出现在 depends 里', () => {
    const problems = problemsOf({
      runId: 'r',
      nodes: [node('a'), node('b', { inputs: [{ from: 'a' }] })],
    });
    expect(problems).toContain('node "b".inputs["a"] must also appear in depends');
  });

  it('inputs 与 depends 一致时通过', () => {
    const dag = dagOf([node('a'), node('b', { depends: ['a'], inputs: [{ from: 'a', select: 'k' }] })]);
    expect(dag.nodes[1]!.inputs).toEqual([{ from: 'a', select: 'k' }]);
  });

  it('拒绝非法 runId 与非法节点 id（要落进路径和 attemptId）', () => {
    expect(problemsOf({ runId: 'bad id/../x', nodes: [node('a')] }).some((p) => p.includes('runId'))).toBe(true);
    expect(problemsOf({ runId: 'r', nodes: [node('a/b')] }).some((p) => p.includes('node id'))).toBe(true);
  });

  it('nodes 为空直接拒绝', () => {
    expect(() => validateDag({ runId: 'r', nodes: [] })).toThrow(DagValidationError);
  });

  it('retry.maxAttempts 必须是 >=1 的整数', () => {
    expect(problemsOf({ runId: 'r', nodes: [node('a', { retry: { maxAttempts: 0 } })] })).toContain(
      'node "a".retry.maxAttempts must be an integer >= 1',
    );
    expect(dagOf([node('a', { retry: { maxAttempts: 3 } })]).nodes[0]!.maxAttempts).toBe(3);
  });

  it('humanGate 需要非空 prompt，timeoutMs 必须为正', () => {
    expect(problemsOf({ runId: 'r', nodes: [node('a', { humanGate: { prompt: '  ' } })] }).length).toBe(1);
    expect(
      problemsOf({ runId: 'r', nodes: [node('a', { humanGate: { prompt: 'ok', timeoutMs: -5 } })] }),
    ).toContain('node "a".humanGate.timeoutMs must be a positive number');
    const dag = dagOf([node('a', { humanGate: { prompt: '确认发布', timeoutMs: 1000 } })]);
    expect(dag.nodes[0]!.humanGate).toEqual({ prompt: '确认发布', timeoutMs: 1000 });
  });

  it('边谓词必须恰好一个算子', () => {
    const problems = problemsOf({
      runId: 'r',
      nodes: [node('a'), node('b', { depends: [{ from: 'a', when: { key: 'k', equals: 1, exists: true } }] })],
    });
    expect(problems.some((p) => p.includes('exactly one of equals/notEquals/in/exists'))).toBe(true);
  });

  it('边谓词 in 必须是非空数组', () => {
    expect(
      problemsOf({ runId: 'r', nodes: [node('a'), node('b', { depends: [{ from: 'a', when: { key: 'k', in: [] } }] })] })
        .some((p) => p.includes('.in must be a non-empty array')),
    ).toBe(true);
  });
});

describe('拓扑排序', () => {
  it('尊重依赖顺序：上游一定排在下游之前', () => {
    const dag = dagOf([
      node('report', { depends: ['research', 'design'] }),
      node('research'),
      node('design', { depends: ['research'] }),
    ]);
    const order = topologicalOrder(dag);
    expect(order.indexOf('research')).toBeLessThan(order.indexOf('design'));
    expect(order.indexOf('design')).toBeLessThan(order.indexOf('report'));
    expect(order).toHaveLength(3);
  });

  it('顺序稳定：同样的 DAG 无论节点书写顺序如何，结果一致（journal 可复现的前提）', () => {
    const forward = dagOf([node('a'), node('b'), node('c'), node('d', { depends: ['a', 'b', 'c'] })]);
    const shuffled = dagOf([node('c'), node('d', { depends: ['c', 'a', 'b'] }), node('a'), node('b')]);
    expect(topologicalOrder(forward)).toEqual(['a', 'b', 'c', 'd']);
    expect(topologicalOrder(shuffled)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('并行分支：互不依赖的节点都出现，且各自的上游在前', () => {
    const dag = dagOf([
      node('root'),
      node('left', { depends: ['root'] }),
      node('right', { depends: ['root'] }),
      node('join', { depends: ['left', 'right'] }),
    ]);
    const order = topologicalOrder(dag);
    expect(order[0]).toBe('root');
    expect(order.at(-1)).toBe('join');
    expect(order.indexOf('left')).toBeLessThan(order.indexOf('join'));
    expect(order.indexOf('right')).toBeLessThan(order.indexOf('join'));
  });
});

describe('环检测', () => {
  it('validateDag 拒绝成环的 DAG', () => {
    expect(() => validateDag({ runId: 'r', nodes: [node('a', { depends: ['b'] }), node('b', { depends: ['a'] })] }))
      .toThrow(DagValidationError);
  });

  it('报出的是真正的环路径，而不是所有排不完的节点', () => {
    // a→b→c→a 成环，d/e 只是挂在环下游，不该被算进环里。
    const problems = problemsOf({
      runId: 'r',
      nodes: [
        node('a', { depends: ['c'] }),
        node('b', { depends: ['a'] }),
        node('c', { depends: ['b'] }),
        node('d', { depends: ['c'] }),
        node('e', { depends: ['d'] }),
      ],
    });
    expect(problems).toHaveLength(1);
    const message = problems[0]!;
    expect(message).toContain('cycle');
    // 断言解析出的环路径本身，而不是整条消息——「dag」里就含字母 d。
    const path = message.slice(message.indexOf(':') + 1).trim().split(' -> ');
    expect(path).not.toContain('d');
    expect(path).not.toContain('e');
    // 环路径首尾闭合
    expect(path[0]).toBe(path.at(-1));
    expect(new Set(path).size).toBe(3);
    expect([...new Set(path)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('自环也被 depends-on-itself 挡住', () => {
    expect(problemsOf({ runId: 'r', nodes: [node('a', { depends: ['a'] })] })).toContain(
      'node "a" depends on itself',
    );
  });

  it('findCycle 对无环图返回 undefined', () => {
    expect(findCycle(dagOf([node('a'), node('b', { depends: ['a'] })]))).toBeUndefined();
  });
});

describe('findSinks', () => {
  it('只返回没有下游的节点', () => {
    const dag = dagOf([node('a'), node('b', { depends: ['a'] }), node('c', { depends: ['a'] })]);
    expect(findSinks(dag).sort()).toEqual(['b', 'c']);
  });
});

describe('evaluateEdgePredicate', () => {
  it('equals / notEquals 按值比较', () => {
    expect(evaluateEdgePredicate({ key: 'v', equals: 'yes' }, { v: 'yes' })).toBe(true);
    expect(evaluateEdgePredicate({ key: 'v', equals: 'yes' }, { v: 'no' })).toBe(false);
    expect(evaluateEdgePredicate({ key: 'v', notEquals: 'yes' }, { v: 'no' })).toBe(true);
  });

  it('in 判断成员资格', () => {
    expect(evaluateEdgePredicate({ key: 'v', in: ['a', 'b'] }, { v: 'b' })).toBe(true);
    expect(evaluateEdgePredicate({ key: 'v', in: ['a', 'b'] }, { v: 'z' })).toBe(false);
  });

  it('exists 区分 key 缺失与值为假', () => {
    expect(evaluateEdgePredicate({ key: 'v', exists: true }, { v: false })).toBe(true);
    expect(evaluateEdgePredicate({ key: 'v', exists: true }, {})).toBe(false);
    expect(evaluateEdgePredicate({ key: 'v', exists: false }, {})).toBe(true);
  });

  it('key 缺失时非 exists 谓词一律不满足（含 notEquals）', () => {
    // notEquals 尤其要注意：缺失 ≠ "不等于"，否则一个没产出的上游会意外放行下游。
    expect(evaluateEdgePredicate({ key: 'v', notEquals: 'x' }, {})).toBe(false);
    expect(evaluateEdgePredicate({ key: 'v', equals: 'x' }, undefined)).toBe(false);
  });
});
