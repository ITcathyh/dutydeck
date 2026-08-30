/**
 * 纯决策层：给定 DAG + 当前运行态，算出「现在可以做什么」。
 *
 * 移植自 botmux `src/workflows/v3/orchestrator.ts` 的核心思路——也是整个包
 * 最值得抄的一个设计：**决策与副作用彻底分离**。这里没有 async、没有 fs、
 * 没有进程，只有 `(dag, snapshot) => Action[]`。调度语义因此能在毫秒级、
 * 零 mock 的前提下被断言；engine 只负责把动作翻译成 journal 写入和执行器调用。
 *
 * 砍掉的 botmux 分支：loop 迭代、instance supersede、cancelNode（early-release）、
 * host effect。保留了真正的核心：拓扑序、fail-fast、条件边、汇合规则、闸门。
 */

import { evaluateEdgePredicate, findSinks, topologicalOrder } from './dag.js';
import type {
  NormalizedDag,
  NormalizedNode,
  NodeState,
  RunSnapshot,
  WorkflowAction,
} from './types.js';

const PENDING: NodeState = { status: 'pending', attempts: 0 };

const stateOf = (snap: RunSnapshot, id: string): NodeState => snap.nodes.get(id) ?? PENDING;

export const edgeKey = (from: string, to: string): string => `${from}->${to}`;

/** 单条依赖边在当前快照下的裁决。 */
type EdgeActivity =
  | { kind: 'active' }              // 上游成功且边激活 —— 计入 triggerRule 的分子
  | { kind: 'dead' }                // 上游 skipped，或边判定为不激活 —— 永远不会再满足
  | { kind: 'undecided' }           // 上游还在跑
  | { kind: 'needsResolve' };       // 上游 done 但条件边还没裁决过

function edgeActivity(
  snap: RunSnapshot,
  from: string,
  to: string,
  hasPredicate: boolean,
): EdgeActivity {
  const source = stateOf(snap, from);
  switch (source.status) {
    case 'done':
      break;
    case 'skipped':
    case 'failed':
    case 'blocked':
      return { kind: 'dead' };
    default:
      return { kind: 'undecided' };
  }
  if (!hasPredicate) return { kind: 'active' };
  const verdict = snap.edges.get(edgeKey(from, to));
  // 条件边的裁决**必须先落 journal 再使用**：否则同一份 journal 重放时，
  // 若上游 outputs 后来变了，边的结论会跟着变，快照就不再是事件的纯函数。
  if (!verdict) return { kind: 'needsResolve' };
  return verdict.active ? { kind: 'active' } : { kind: 'dead' };
}

type Readiness =
  | { kind: 'ready' }
  | { kind: 'wait' }
  | { kind: 'skip'; detail: string }
  | { kind: 'resolveEdges'; froms: string[] };

/** 依据 triggerRule 判断节点是否就绪、是否已经不可能就绪。 */
export function readinessFor(node: NormalizedNode, snap: RunSnapshot): Readiness {
  const required =
    node.triggerRule === 'all_success' ? node.depends.length
    : node.triggerRule === 'one_success' ? 1
    : node.triggerRule.quorum;

  if (node.depends.length === 0) return { kind: 'ready' };

  let active = 0;
  let undecided = 0;
  const needsResolve: string[] = [];
  for (const dep of node.depends) {
    const activity = edgeActivity(snap, dep.from, node.id, dep.when !== undefined);
    if (activity.kind === 'active') active++;
    else if (activity.kind === 'undecided') undecided++;
    else if (activity.kind === 'needsResolve') needsResolve.push(dep.from);
  }

  // 先把能裁决的边裁决掉，下一 tick 再谈就绪——保证 journal 里边的顺序稳定。
  if (needsResolve.length > 0) return { kind: 'resolveEdges', froms: needsResolve };

  if (active >= required) return { kind: 'ready' };
  // 剩下未定的全成功也不够 → 这个节点永远不会就绪，判 skipped 而不是干等。
  if (active + undecided < required) {
    return {
      kind: 'skip',
      detail: `triggerRule ${describeTrigger(node.triggerRule)} unsatisfiable: ${active} active, ${undecided} undecided of ${node.depends.length} deps`,
    };
  }
  return { kind: 'wait' };
}

const describeTrigger = (rule: NormalizedNode['triggerRule']): string =>
  typeof rule === 'string' ? rule : `quorum(${rule.quorum})`;

/** `done` / `skipped` 都是可接受的终态——run 成功不要求每个节点都跑过。 */
const isAcceptableTerminal = (status: NodeState['status']): boolean =>
  status === 'done' || status === 'skipped';

/**
 * 纯决策。返回**当前所有可执行动作**，不做并发节流——engine 想限流就只取前 N 个，
 * 下一 tick 再来。
 *
 * fail-fast：任何节点 failed 就只返回 completeRunFailed；failed 优先于 blocked
 * （前者需要人介入，后者可重试，同时存在时先报更严重的那个）。取拓扑序最早的那个
 * 节点作为归因，保证同样的状态永远给出同样的 failedNodeId。
 */
export function decideNext(dag: NormalizedDag, snap: RunSnapshot): WorkflowAction[] {
  const order = topologicalOrder(dag);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));

  for (const id of order) {
    if (stateOf(snap, id).status === 'failed') {
      return [{ kind: 'completeRunFailed', failedNodeId: id }];
    }
  }
  for (const id of order) {
    if (stateOf(snap, id).status === 'blocked') {
      return [{ kind: 'completeRunBlocked', blockedNodeId: id }];
    }
  }

  const actions: WorkflowAction[] = [];
  let pending = 0;

  for (const id of order) {
    const node = byId.get(id)!;
    const s = stateOf(snap, id);
    if (isAcceptableTerminal(s.status)) continue;

    pending++;
    if (s.status === 'running' || s.status === 'gateWaiting') continue;

    const readiness = readinessFor(node, snap);
    if (readiness.kind === 'wait') continue;
    if (readiness.kind === 'resolveEdges') {
      for (const from of readiness.froms) actions.push({ kind: 'resolveEdge', from, to: id });
      continue;
    }
    if (readiness.kind === 'skip') {
      actions.push({ kind: 'skipNode', nodeId: id, detail: readiness.detail });
      continue;
    }
    // 闸门在工作之前：放行后 gateCleared 置位，下一 tick 才派发真正的工作。
    if (node.humanGate && !s.gateCleared) {
      actions.push({ kind: 'dispatchGate', nodeId: id });
      continue;
    }
    actions.push({ kind: 'dispatchWork', nodeId: id });
  }

  if (pending === 0 && actions.length === 0) {
    // 全部 sink 都被 skip 掉 = 这次 run 什么产物都没有。这不是成功。
    const sinks = findSinks(dag);
    const allSinksSkipped =
      sinks.length > 0 && sinks.every((id) => stateOf(snap, id).status === 'skipped');
    if (allSinksSkipped) {
      return [{ kind: 'completeRunFailed', detail: 'allSinksSkipped' }];
    }
    return [{ kind: 'completeRunSucceeded' }];
  }
  return actions;
}

/** 为一条待裁决的边求值。engine 用它算出 edgeResolved 事件的 `active`。 */
export function resolveEdgeVerdict(
  dag: NormalizedDag,
  snap: RunSnapshot,
  from: string,
  to: string,
): boolean {
  const target = dag.nodes.find((n) => n.id === to);
  const dep = target?.depends.find((d) => d.from === from);
  if (!dep?.when) return true;
  return evaluateEdgePredicate(dep.when, stateOf(snap, from).outputs);
}

export { findSinks, topologicalOrder };
