/**
 * dockmux workflow —— 核心类型契约。
 *
 * 这一层是整个包唯一的「词汇表」：DAG 定义、运行态、journal 事件、以及与
 * 外部执行器之间的注入接缝（{@link NodeExecutor}）。所有其它模块都从这里导入，
 * 不反向依赖。
 *
 * 与 botmux v3 的关系
 * ────────────────────
 * 数据模型移植自 botmux `src/workflows/v3/`（dag.ts / event-contract.ts /
 * orchestrator.ts），但**刻意砍掉了 dockmux 支撑不起来的部分**：
 *
 *  - host 节点（feishu-send / feishu-reply / botmux-schedule）—— 绑死飞书；
 *  - loop 节点、revisitTo、instance 层 —— 依赖 ephemeral-pool 与 worker-fence；
 *  - manifest / artifact 文件契约 —— 依赖 botmux 的 `botmux-goal` skill 让 CLI
 *    自己往 outputDir 写 manifest.json；dockmux 没有这条约定，硬移过来就是
 *    「节点永远产不出 manifest」的死代码。
 *
 * 取而代之：节点的产物是**结构化的 outputs 对象**，由注入的 {@link NodeExecutor}
 * 返回，直接进 journal。下游节点通过 `inputs` 拿到上游的 outputs。这样整条链路
 * 不依赖任何文件系统约定，也不依赖 CLI 配合。
 */

// ─── DAG 定义 ────────────────────────────────────────────────────────────────

/**
 * 依赖边。边**存在目标节点上**（入边），没有独立的 edge 列表——与 botmux 一致。
 *
 * `when` 让边变成条件边：只有当上游 outputs 满足谓词时这条边才「激活」。
 * 未激活的边对下游而言等价于「这个上游没成功」，配合 `triggerRule` 就得到了分支。
 */
export interface DependRef {
  readonly from: string;
  readonly when?: EdgePredicate;
}

/**
 * 条件边谓词——**刻意只保留 4 个算子**。
 *
 * botmux 的 `normLoopExitWhen` 支持更多算子并且要求上游声明 resultSchema 做
 * 编译期类型/enum 对账。这里没有 resultSchema，所以谓词是运行期求值的：
 * 取上游 outputs 的 `key`，与操作数比较。缺失的 key 一律视为不满足（除了 `exists`）。
 */
export type EdgePredicate =
  | { readonly key: string; readonly equals: string | number | boolean }
  | { readonly key: string; readonly notEquals: string | number | boolean }
  | { readonly key: string; readonly in: readonly (string | number | boolean)[] }
  | { readonly key: string; readonly exists: boolean };

/**
 * 数据流引用：把上游节点的 outputs 注入本节点。
 *
 * 硬约束（validateDag 强制）：每个 `inputs.from` 必须同时出现在 `depends` 里。
 * 控制流（depends）与数据流（inputs）是两条正交通道，但数据流不能凭空产生依赖。
 */
export interface InputRef {
  readonly from: string;
  /** 只取上游 outputs 的这个 key；省略则整个 outputs 对象都注入。 */
  readonly select?: string;
}

/**
 * 汇合规则：多个上游时，多少个「成功」才算就绪。
 *
 * - `all_success`（默认）—— 全部上游都 done 且边激活
 * - `one_success`     —— 任意一个
 * - `{ quorum: n }`   —— 至少 n 个
 *
 * 同时决定「不可能再满足」的时刻：当剩余未定上游数量不足以补齐时，节点转 `skipped`。
 */
export type TriggerRule = 'all_success' | 'one_success' | { readonly quorum: number };

/** 人工闸门。挂在节点上，节点派发前必须先由人放行。 */
export interface HumanGate {
  /** 展示给人看的问题/说明。 */
  readonly prompt: string;
  /**
   * 等待超时（毫秒）。超时后闸门自动判定为 `expired`，节点转 `failed`。
   * 省略则永久等待——由调用方自己决定何时放弃。
   */
  readonly timeoutMs?: number;
}

/** 节点的重试策略。 */
export interface RetryPolicy {
  /**
   * 最多尝试几次（含首次）。默认 1 = 不重试。
   *
   * 只对 `blocked`（语义/契约失败，可恢复）自动重试；`failed`（基础设施失败）
   * 不自动重试——这与 botmux 的两档终态语义一致，理由见 NodeStatus。
   */
  readonly maxAttempts?: number;
}

export interface WorkflowNode {
  readonly id: string;
  /** 交给执行器的任务描述。 */
  readonly goal: string;
  /** 用哪个 dockmux agent 跑（对应 AgentConfig.id）。省略则由执行器自己决定。 */
  readonly agent?: string;
  readonly depends?: readonly (string | DependRef)[];
  readonly inputs?: readonly InputRef[];
  readonly triggerRule?: TriggerRule;
  readonly humanGate?: HumanGate;
  readonly retry?: RetryPolicy;
  /** 单次尝试的超时（毫秒）。 */
  readonly timeoutMs?: number;
}

export interface WorkflowDag {
  readonly runId: string;
  readonly nodes: readonly WorkflowNode[];
}

/** 归一化后的节点——`depends` 一律是 DependRef[]，可选字段都已填默认值。 */
export interface NormalizedNode {
  readonly id: string;
  readonly goal: string;
  readonly agent?: string;
  readonly depends: readonly DependRef[];
  readonly inputs: readonly InputRef[];
  readonly triggerRule: TriggerRule;
  readonly humanGate?: HumanGate;
  readonly maxAttempts: number;
  readonly timeoutMs?: number;
}

/** 归一化 + 校验通过的 DAG。只有 {@link validateDag} 能造出来。 */
export interface NormalizedDag {
  readonly runId: string;
  readonly nodes: readonly NormalizedNode[];
}

// ─── 运行态 ──────────────────────────────────────────────────────────────────

/**
 * 节点状态机。
 *
 * `blocked` 与 `failed` 分两档是从 botmux 学来的关键设计，不要合并：
 *  - `blocked` = 语义/契约失败（产物不合格、执行器说需要人补信息）。**可重试**，
 *    run 整体停在 `blocked` 等人干预，干预后能原地续跑。
 *  - `failed`  = 基础设施失败（进程崩了、超时、闸门被拒）。**不自动重试**，
 *    run 直接 fail-fast。
 * 合并两者的后果是：要么把不该重试的崩溃反复重试，要么把可恢复的契约失败
 * 直接判死。
 */
export type NodeStatus =
  | 'pending'      // 未派发（依赖可能还没就绪）
  | 'gateWaiting'  // 闸门已派发，等人裁决
  | 'running'      // 已派发给执行器，在飞
  | 'done'         // 成功
  | 'skipped'      // triggerRule 不可能再满足——可接受的终态，不是失败
  | 'blocked'      // 语义失败，可重试
  | 'failed';      // 基础设施失败 / 闸门被拒 / 超时

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'blocked';

export interface NodeState {
  readonly status: NodeStatus;
  /** 闸门放行后置位——下一 tick 派发工作而不是重新派发闸门。 */
  readonly gateCleared?: boolean;
  /** 已经消耗掉的尝试次数。 */
  readonly attempts: number;
  /** 最近一次结果的 outputs（成功时）。下游 inputs 从这里取。 */
  readonly outputs?: Readonly<Record<string, unknown>>;
  /** 最近一次失败/阻塞的说明。 */
  readonly message?: string;
  readonly errorClass?: NodeErrorClass;
}

export type NodeErrorClass =
  | 'executorError'   // 执行器自己抛了/进程挂了
  | 'timeout'
  | 'resultInvalid'   // 产物不合格（语义失败 → blocked）
  | 'gateRejected'
  | 'gateExpired';

/** 边的裁决结果：`${from}->${to}` → 是否激活。 */
export interface EdgeState {
  readonly active: boolean;
}

/** 闸门等待记录。 */
export interface GateState {
  readonly nodeId: string;
  readonly waitId: string;
  readonly prompt: string;
  /** 闸门派发时刻（epoch ms），用于判超时。 */
  readonly openedAt: number;
  readonly timeoutMs?: number;
}

/**
 * 由 journal 回放出来的运行快照。**纯派生**——同样的事件序列永远得到同样的快照，
 * 所以快照可以随时丢掉重算，不会成为独立的、会漂移的第二真相。
 */
export interface RunSnapshot {
  readonly runId: string;
  readonly runStatus: RunStatus;
  /** nodeId → 节点状态。不在 map 里的节点视为 `pending`。 */
  readonly nodes: ReadonlyMap<string, NodeState>;
  /** `${from}->${to}` → 边裁决（首次裁决即固化）。 */
  readonly edges: ReadonlyMap<string, EdgeState>;
  /** nodeId → 未决闸门。 */
  readonly openGates: ReadonlyMap<string, GateState>;
  readonly failedNodeId?: string;
  readonly blockedNodeId?: string;
}

// ─── Journal 事件 ────────────────────────────────────────────────────────────

/**
 * append-only 事件流。这是 run 的审计真相，{@link RunSnapshot} 只是它的物化。
 *
 * 相比 botmux 的 30+ 种事件，这里只留 12 种——砍掉的都是 host effect、loop、
 * instance supersede、worker fence、cancel-request 这些 dockmux 没有对应基建的。
 */
export type WorkflowEvent =
  | { readonly type: 'runStarted'; readonly runId: string }
  | { readonly type: 'nodeDispatched'; readonly nodeId: string; readonly attemptId: string }
  | {
      readonly type: 'nodeSucceeded';
      readonly nodeId: string;
      readonly attemptId: string;
      readonly outputs?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'nodeFailed';
      readonly nodeId: string;
      readonly attemptId: string;
      readonly errorClass: NodeErrorClass;
      readonly message?: string;
    }
  | {
      readonly type: 'nodeBlocked';
      readonly nodeId: string;
      readonly attemptId: string;
      readonly errorClass: NodeErrorClass;
      readonly message?: string;
    }
  | {
      readonly type: 'nodeRetryRequested';
      readonly nodeId: string;
      readonly previousAttemptId: string;
      readonly nextAttemptId: string;
    }
  | { readonly type: 'nodeSkipped'; readonly nodeId: string; readonly detail?: string }
  | {
      readonly type: 'gateDispatched';
      readonly nodeId: string;
      readonly waitId: string;
      readonly prompt: string;
      readonly timeoutMs?: number;
    }
  | {
      readonly type: 'gateResolved';
      readonly nodeId: string;
      readonly waitId: string;
      readonly resolution: 'approved' | 'rejected' | 'expired';
      readonly by: string;
    }
  | {
      readonly type: 'edgeResolved';
      readonly from: string;
      readonly to: string;
      readonly active: boolean;
    }
  | { readonly type: 'runSucceeded' }
  | { readonly type: 'runFailed'; readonly failedNodeId?: string; readonly detail?: string }
  | { readonly type: 'runBlocked'; readonly blockedNodeId: string };

/** 落盘后的事件——多一个写入时刻。 */
export type StoredEvent = WorkflowEvent & { readonly ts: number };

// ─── 调度动作 ────────────────────────────────────────────────────────────────

/**
 * 纯决策层的输出。{@link decideNext} 只产出这些描述符，**不做任何副作用**；
 * 由 engine 翻译成 journal 写入 + 执行器调用。
 *
 * 这条分界线是整个包可测性的基础：调度语义能在不 spawn 任何进程、不碰文件系统的
 * 前提下被断言。
 */
export type WorkflowAction =
  | { readonly kind: 'resolveEdge'; readonly from: string; readonly to: string }
  | { readonly kind: 'skipNode'; readonly nodeId: string; readonly detail?: string }
  | { readonly kind: 'dispatchGate'; readonly nodeId: string }
  | { readonly kind: 'dispatchWork'; readonly nodeId: string }
  | { readonly kind: 'completeRunSucceeded' }
  | { readonly kind: 'completeRunFailed'; readonly failedNodeId?: string; readonly detail?: string }
  | { readonly kind: 'completeRunBlocked'; readonly blockedNodeId: string };

// ─── 注入接缝 ────────────────────────────────────────────────────────────────

/** 注入给执行器的单条上游输入。 */
export interface ResolvedInput {
  readonly from: string;
  /** `select` 命中的那个值；未指定 select 时是上游整个 outputs 对象。 */
  readonly value: unknown;
}

/**
 * 「这个上游本来该给我输入，但它没给」——并且这是**已知的、正常的**缺席。
 *
 * 显式告知执行器，比让它面对一个静默变短的 inputs 数组要好：后者会让 agent
 * 以为上游产物存在只是自己没找到，从而幻觉补全。
 */
export interface OmittedInput {
  readonly from: string;
  readonly reason: 'edgeInactive' | 'sourceSkipped';
}

export interface NodeRunRequest {
  readonly runId: string;
  readonly nodeId: string;
  /** `<nodeId>/attempts/001` —— 全局唯一，可用作幂等键。 */
  readonly attemptId: string;
  readonly goal: string;
  readonly agent?: string;
  readonly inputs: readonly ResolvedInput[];
  readonly omitted: readonly OmittedInput[];
  /** 超时或 run 被取消时 abort。执行器**必须**响应。 */
  readonly signal: AbortSignal;
}

/**
 * 执行器返回的终态。三档对应 {@link NodeStatus} 的三种终态语义。
 *
 * 执行器**不应该**为超时返回任何东西——超时由 engine 通过 signal + 竞速判定，
 * 执行器只要响应 abort 即可。
 */
export type NodeRunResult =
  | { readonly status: 'succeeded'; readonly outputs?: Readonly<Record<string, unknown>> }
  | { readonly status: 'blocked'; readonly message?: string }
  | { readonly status: 'failed'; readonly message?: string };

/**
 * **本包唯一的外部依赖接缝。**
 *
 * `packages/workflow` 不依赖 `@dockmux/runtime`，更不依赖 `apps/server`：
 * 集成方实现这个接口，把 DockmuxRuntime 的「开会话 → 发 prompt → 等完成 →
 * 收结果」包成一次 `run()` 调用。这样本包可以用假执行器完整测试调度语义，
 * 也能独立于 runtime 演进。
 */
export interface NodeExecutor {
  run(request: NodeRunRequest): Promise<NodeRunResult>;
}

/** 可注入的时钟——让超时相关的测试不依赖真实时间。 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
