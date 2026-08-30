/**
 * `@dockmux/workflow` —— 从 botmux v3 提取的 workflow 引擎核心子集。
 *
 * 最小闭环：定义 DAG → 按依赖顺序调度 → 每个节点交给注入的执行器 →
 * 事件写 append-only journal → 崩溃后重放 journal 即可续跑 → 节点可卡人工闸门。
 *
 * 本包**不依赖** `@dockmux/runtime`，更不依赖 `apps/server`。要接真实会话，
 * 由集成方实现 {@link NodeExecutor}（唯一接缝），把 DockmuxRuntime 包进去。
 */

export {
  DagValidationError,
  evaluateEdgePredicate,
  findCycle,
  findSinks,
  nodeById,
  topologicalOrder,
  validateDag,
} from './dag.js';

export { decideNext, edgeKey, readinessFor, resolveEdgeVerdict } from './orchestrator.js';

export {
  Journal,
  JournalCorruptionError,
  MemoryJournal,
  readJournal,
  type JournalSink,
} from './journal.js';

export { formatAttemptId, materialize, nextAttemptId } from './state.js';

export {
  autoApproveGate,
  ManualGateResolver,
  type GateOutcome,
  type GateRequest,
  type GateResolver,
} from './gate.js';

export { WorkflowEngine, type EngineOptions, type RunOutcome } from './engine.js';

export { systemClock } from './types.js';
export type {
  Clock,
  DependRef,
  EdgePredicate,
  EdgeState,
  GateState,
  HumanGate,
  InputRef,
  NodeErrorClass,
  NodeExecutor,
  NodeRunRequest,
  NodeRunResult,
  NodeState,
  NodeStatus,
  NormalizedDag,
  NormalizedNode,
  OmittedInput,
  ResolvedInput,
  RetryPolicy,
  RunSnapshot,
  RunStatus,
  StoredEvent,
  TriggerRule,
  WorkflowAction,
  WorkflowDag,
  WorkflowEvent,
  WorkflowNode,
} from './types.js';
