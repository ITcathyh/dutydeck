/**
 * DAG 定义、校验与拓扑排序。
 *
 * 移植自 botmux `src/workflows/v3/dag.ts`（1648 行），但只保留 goal 节点这一条
 * 主干：host 节点（feishu-send / botmux-schedule）、loop 子图、revisitTo 回跳、
 * instance 层全部砍掉——它们要么绑死飞书，要么依赖 ephemeral-pool / worker-fence，
 * dockmux 一样都没有。剩下的 schema + 校验 + Kahn 拓扑排序是真正与基建无关的部分。
 *
 * 校验策略沿用 botmux：**累积所有问题再一次性抛**（`DagValidationError.problems`），
 * 而不是遇到第一个就抛。写 DAG 的人一次就能看到全部错误，不用挤牙膏式地改一个跑一次。
 */

import type {
  DependRef,
  EdgePredicate,
  InputRef,
  NormalizedDag,
  NormalizedNode,
  TriggerRule,
  WorkflowDag,
  WorkflowNode,
} from './types.js';

export class DagValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid workflow DAG:\n  - ${problems.join('\n  - ')}`);
    this.name = 'DagValidationError';
  }
}

/** 节点 id / runId 必须是路径安全的——它们会被拼进 attemptId 和落盘路径。 */
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function normDepends(raw: unknown, nodeId: string, problems: string[]): DependRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`node "${nodeId}".depends must be an array`);
    return [];
  }
  const out: DependRef[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let ref: DependRef | undefined;
    if (typeof entry === 'string') ref = { from: entry };
    else if (isObject(entry) && typeof entry['from'] === 'string') {
      const when = entry['when'];
      // when 的形状在 normEdgePredicate 里查；这里只负责把两种书写形式归一。
      ref = when === undefined
        ? { from: entry['from'] }
        : { from: entry['from'], when: normEdgePredicate(when, nodeId, entry['from'], problems) };
    }
    if (!ref) {
      problems.push(`node "${nodeId}".depends entries must be a string or { from, when? }`);
      continue;
    }
    if (ref.from === nodeId) {
      problems.push(`node "${nodeId}" depends on itself`);
      continue;
    }
    // 同一 (from,to) 只允许一条边——这让 `${from}->${to}` 成为稳定的幂等键，
    // edgeResolved 的「首次裁决即固化」才有意义。
    if (seen.has(ref.from)) {
      problems.push(`node "${nodeId}".depends has duplicate entry "${ref.from}"`);
      continue;
    }
    seen.add(ref.from);
    out.push(ref);
  }
  return out;
}

function normEdgePredicate(
  raw: unknown,
  nodeId: string,
  from: string,
  problems: string[],
): EdgePredicate | undefined {
  const where = `node "${nodeId}".depends["${from}"].when`;
  if (!isObject(raw)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  const key = raw['key'];
  if (typeof key !== 'string' || !key) {
    problems.push(`${where}.key must be a non-empty string`);
    return undefined;
  }
  // 恰好一个算子：多写一个就意味着语义歧义，宁可拒绝也不要猜。
  const ops = (['equals', 'notEquals', 'in', 'exists'] as const).filter((op) => op in raw);
  if (ops.length !== 1) {
    problems.push(`${where} must have exactly one of equals/notEquals/in/exists (got ${ops.length})`);
    return undefined;
  }
  const op = ops[0]!;
  const operand = raw[op];
  if (op === 'in') {
    if (!Array.isArray(operand) || operand.length === 0) {
      problems.push(`${where}.in must be a non-empty array`);
      return undefined;
    }
    for (const v of operand) {
      if (!isScalar(v)) {
        problems.push(`${where}.in entries must be string/number/boolean`);
        return undefined;
      }
    }
    return { key, in: operand as (string | number | boolean)[] };
  }
  if (op === 'exists') {
    if (typeof operand !== 'boolean') {
      problems.push(`${where}.exists must be a boolean`);
      return undefined;
    }
    return { key, exists: operand };
  }
  if (!isScalar(operand)) {
    problems.push(`${where}.${op} must be string/number/boolean`);
    return undefined;
  }
  return op === 'equals' ? { key, equals: operand } : { key, notEquals: operand };
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function normInputs(raw: unknown, nodeId: string, problems: string[]): InputRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`node "${nodeId}".inputs must be an array`);
    return [];
  }
  const out: InputRef[] = [];
  for (const entry of raw) {
    if (!isObject(entry) || typeof entry['from'] !== 'string') {
      problems.push(`node "${nodeId}".inputs entries must be { from, select? }`);
      continue;
    }
    const select = entry['select'];
    if (select !== undefined && (typeof select !== 'string' || !select)) {
      problems.push(`node "${nodeId}".inputs["${entry['from']}"].select must be a non-empty string`);
      continue;
    }
    out.push(select === undefined ? { from: entry['from'] } : { from: entry['from'], select });
  }
  return out;
}

function normTriggerRule(raw: unknown, nodeId: string, problems: string[]): TriggerRule {
  if (raw === undefined) return 'all_success';
  if (raw === 'all_success' || raw === 'one_success') return raw;
  if (isObject(raw) && typeof raw['quorum'] === 'number') {
    const q = raw['quorum'];
    if (!Number.isInteger(q) || q < 1) {
      problems.push(`node "${nodeId}".triggerRule.quorum must be a positive integer`);
      return 'all_success';
    }
    return { quorum: q };
  }
  problems.push(`node "${nodeId}".triggerRule must be 'all_success' | 'one_success' | { quorum }`);
  return 'all_success';
}

/**
 * 校验并归一化一份 DAG。这是造出 {@link NormalizedDag} 的唯一入口——
 * 下游（orchestrator / engine）因此可以假定所有引用都存在、图无环、默认值已填好。
 */
export function validateDag(raw: unknown): NormalizedDag {
  const problems: string[] = [];
  if (!isObject(raw)) throw new DagValidationError(['dag must be an object']);

  const runId = raw['runId'];
  if (typeof runId !== 'string' || !SAFE_ID_RE.test(runId)) {
    problems.push(`dag.runId must match ${SAFE_ID_RE} (got ${JSON.stringify(runId)})`);
  }
  const rawNodes = raw['nodes'];
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    // 这条直接短路：后面所有检查都以 nodes 为前提，继续跑只会产生噪音。
    throw new DagValidationError([...problems, 'dag.nodes must be a non-empty array']);
  }

  const nodes: NormalizedNode[] = [];
  const ids = new Set<string>();
  for (const rawNode of rawNodes as unknown[]) {
    if (!isObject(rawNode)) {
      problems.push('dag.nodes entries must be objects');
      continue;
    }
    const id = rawNode['id'];
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
      problems.push(`node id must match ${SAFE_ID_RE} (got ${JSON.stringify(id)})`);
      continue;
    }
    if (ids.has(id)) {
      problems.push(`duplicate node id "${id}"`);
      continue;
    }
    ids.add(id);

    const goal = rawNode['goal'];
    if (typeof goal !== 'string' || !goal.trim()) {
      problems.push(`node "${id}".goal must be a non-empty string`);
    }
    const agent = rawNode['agent'];
    if (agent !== undefined && (typeof agent !== 'string' || !agent)) {
      problems.push(`node "${id}".agent must be a non-empty string`);
    }
    const timeoutMs = rawNode['timeoutMs'];
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !(timeoutMs > 0))) {
      problems.push(`node "${id}".timeoutMs must be a positive number`);
    }

    let maxAttempts = 1;
    const retry = rawNode['retry'];
    if (retry !== undefined) {
      if (!isObject(retry)) {
        problems.push(`node "${id}".retry must be an object`);
      } else if (retry['maxAttempts'] !== undefined) {
        const m = retry['maxAttempts'];
        if (typeof m !== 'number' || !Number.isInteger(m) || m < 1) {
          problems.push(`node "${id}".retry.maxAttempts must be an integer >= 1`);
        } else maxAttempts = m;
      }
    }

    let humanGate: NormalizedNode['humanGate'];
    const gate = rawNode['humanGate'];
    if (gate !== undefined && gate !== null) {
      if (!isObject(gate) || typeof gate['prompt'] !== 'string' || !gate['prompt'].trim()) {
        problems.push(`node "${id}".humanGate.prompt must be a non-empty string`);
      } else {
        const gt = gate['timeoutMs'];
        if (gt !== undefined && (typeof gt !== 'number' || !(gt > 0))) {
          problems.push(`node "${id}".humanGate.timeoutMs must be a positive number`);
        } else {
          humanGate = gt === undefined
            ? { prompt: gate['prompt'] }
            : { prompt: gate['prompt'], timeoutMs: gt as number };
        }
      }
    }

    nodes.push({
      id,
      goal: typeof goal === 'string' ? goal : '',
      ...(typeof agent === 'string' ? { agent } : {}),
      depends: normDepends(rawNode['depends'], id, problems),
      inputs: normInputs(rawNode['inputs'], id, problems),
      triggerRule: normTriggerRule(rawNode['triggerRule'], id, problems),
      ...(humanGate ? { humanGate } : {}),
      maxAttempts,
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    });
  }

  // ── 跨节点检查：引用完整性 ────────────────────────────────────────────────
  for (const node of nodes) {
    for (const dep of node.depends) {
      if (!ids.has(dep.from)) {
        problems.push(`node "${node.id}" depends on unknown node "${dep.from}"`);
      }
    }
    const dependSet = new Set(node.depends.map((d) => d.from));
    for (const input of node.inputs) {
      if (!ids.has(input.from)) {
        problems.push(`node "${node.id}".inputs references unknown node "${input.from}"`);
      } else if (!dependSet.has(input.from)) {
        // 数据流不能凭空产生控制流依赖：否则节点可能在上游还没跑完时就启动，
        // 然后读到一个不存在的 outputs。要数据就必须显式声明依赖。
        problems.push(`node "${node.id}".inputs["${input.from}"] must also appear in depends`);
      }
    }
  }

  if (problems.length > 0) throw new DagValidationError(problems);

  const dag: NormalizedDag = { runId: runId as string, nodes };
  // 放在最后：环检测要求所有 depends 引用都已确认存在。
  const cycle = findCycle(dag);
  if (cycle) {
    throw new DagValidationError([`dag has a cycle: ${cycle.join(' -> ')}`]);
  }
  return dag;
}

/**
 * 找出一条真实的环路径并返回（首尾同一个节点），无环时返回 undefined。
 *
 * botmux 的做法是「拓扑排序排不完 → 报剩下的所有节点」，在「3 个节点成环 + 5 个
 * 节点挂在它下游」时会把 8 个 id 全列出来，人得自己找哪三个才是真的环。
 * 这里改成 DFS 三色标记，回边一出现就沿栈截出真正的环，诊断信息可直接定位。
 */
export function findCycle(dag: NormalizedDag): string[] | undefined {
  const adj = new Map<string, string[]>();
  for (const n of dag.nodes) adj.set(n.id, []);
  for (const n of dag.nodes) {
    for (const dep of n.depends) {
      // 依赖方向 dep.from -> n.id（先跑 from）。未知引用在此之前已被拒绝。
      adj.get(dep.from)?.push(n.id);
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const s = state.get(id);
    if (s === 'done') return undefined;
    if (s === 'visiting') {
      // 回边：栈上从该节点起的那一段就是环本身。
      const at = stack.indexOf(id);
      return [...stack.slice(at), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const n of dag.nodes) {
    const found = visit(n.id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Kahn 拓扑排序，ready 集按 id 升序取——**排序结果必须稳定**。
 *
 * 不稳定的调度顺序会让 journal 在同样的输入下产生不同的事件序列，
 * 崩溃恢复和「重放得到同一快照」的可复现性就没了。
 *
 * 前置条件：`dag` 已经过 {@link validateDag}（引用完整、无环）。
 */
export function topologicalOrder(dag: NormalizedDag): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of dag.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const n of dag.nodes) {
    for (const dep of n.depends) {
      if (!indeg.has(dep.from)) {
        throw new DagValidationError([`node "${n.id}" depends on unknown node "${dep.from}"`]);
      }
      adj.get(dep.from)!.push(n.id);
      indeg.set(n.id, indeg.get(n.id)! + 1);
    }
  }

  const ready = dag.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of adj.get(id)!) {
      const left = indeg.get(next)! - 1;
      indeg.set(next, left);
      if (left === 0) insertSorted(ready, next);
    }
  }
  if (order.length !== dag.nodes.length) {
    const cycle = findCycle(dag);
    throw new DagValidationError([
      cycle ? `dag has a cycle: ${cycle.join(' -> ')}` : 'dag has a cycle',
    ]);
  }
  return order;
}

/** 二分插入，保持 ready 集有序（比每次 push 后重排便宜）。 */
function insertSorted(sorted: string[], value: string): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, value);
}

/** 没有下游的节点——run 的最终产物就是这些节点的 outputs。 */
export function findSinks(dag: NormalizedDag): string[] {
  const hasDownstream = new Set<string>();
  for (const n of dag.nodes) for (const dep of n.depends) hasDownstream.add(dep.from);
  return dag.nodes.filter((n) => !hasDownstream.has(n.id)).map((n) => n.id);
}

/** 对上游 outputs 求值一条边谓词。缺失的 key 一律判为不满足（`exists:false` 除外）。 */
export function evaluateEdgePredicate(
  predicate: EdgePredicate,
  outputs: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const present = outputs !== undefined && Object.prototype.hasOwnProperty.call(outputs, predicate.key);
  if ('exists' in predicate) return present === predicate.exists;
  if (!present) return false;
  const value = outputs![predicate.key];
  if ('equals' in predicate) return value === predicate.equals;
  if ('notEquals' in predicate) return value !== predicate.notEquals;
  return predicate.in.some((candidate) => candidate === value);
}

/** 判断某个 node 是不是这份 DAG 里的节点。 */
export function nodeById(dag: NormalizedDag, id: string): NormalizedNode | undefined {
  return dag.nodes.find((n) => n.id === id);
}

export type { WorkflowDag, WorkflowNode };
