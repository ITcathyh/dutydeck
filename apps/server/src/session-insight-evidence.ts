/**
 * T4e 职责一：宿主证据纯投影。
 *
 * 输入 T4c 在一次短同步读事务中冻结的权威只读数据（执行投影、accepted 输入、
 * 验证记录、费用账本行），输出符合 shared hostEvidenceSnapshotSchema 的
 * HostEvidenceSnapshot：确定性限量、先脱敏后限长、稳定 digest。
 *
 * 本模块不读取 SQL / 文件 / 原始日志，不做 async IO，不推断账本之外的事实：
 * - 验证通过只认真实 VerificationRecord.status === 'passed'，stale/fingerprint
 *   语义原样透传；
 * - 模型配置只取 accepted 输入冻结的 options，不用 session 当前模型替代；
 * - steering delivered 只是投递完成，只投影 target 关系，不产生独立成功；
 * - 费用缺成本记为未知（null/缺字段），绝不写成 0；
 * - 只读投影 recordedAt 范围，不另造收费、不跨会话合计。
 *
 * digest 与持久限量分离：
 * - digest 在限量前对「全量已脱敏业务事实」（含最终被省略的条目）取指纹，
 *   因此仅被省略目标发生变化、可见计数不变时 digest 也会变，cache freshness
 *   不会漏检；
 * - 持久 payload 再按各类固定预算限量：verification/steering/model 各有独立
 *   字节预算，goals 只吃剩余预算，巨大历史 goals 不会饿死三类关键证据；
 *   侧类与 goals 都按「活跃/最新优先」挑选，发布顺序仍回到规范升序。
 */
import { createHash } from 'node:crypto';
import {
  canonicalExecutionJson,
  hostEvidenceSnapshotSchema,
  SESSION_INSIGHT_LIMITS,
  type AcceptedTask,
  type HostEvidenceSnapshot,
  type SteeringOperation,
  type TaskExecutionProjection,
  type UsageLedgerEntry,
  type VerificationResponse
} from '@dutydeck/shared';
import {
  assertSafeIdentity,
  redactExcerpt,
  redactText,
  truncateUtf8Bytes,
  type RedactionContext
} from './session-insight-redaction.js';

const EXCERPT_BYTES = SESSION_INSIGHT_LIMITS.maxExcerptLengthBytes;
const HOST_EVIDENCE_BYTES = SESSION_INSIGHT_LIMITS.maxHostEvidenceBytes;
/** 计量保守余量，覆盖计数位宽、数组分隔等边际字节估算误差。 */
const BUDGET_SLACK_BYTES = 256;
const PLACEHOLDER_DIGEST = '0'.repeat(64);

/**
 * 侧类固定字节预算：即使历史 goals 极大，三类关键证据仍各自保留非空样本。
 * 单条侧类证据 ≤ 4 KiB 摘录 + 少量结构，远小于其预算，故只要存在即可保留。
 */
const VERIFICATION_BUDGET_BYTES = 96 * 1024;
const STEERING_BUDGET_BYTES = 64 * 1024;
const MODEL_BUDGET_BYTES = 48 * 1024;

/** T4c 在短事务中冻结的 session 级权威原始投影（全部 readonly，模块不修改）。 */
export interface HostEvidenceInput {
  /** 本次宿主证据冻结时刻（ISO datetime）；不参与 digest。 */
  capturedAt: string;
  /** 该 session 的全部任务执行投影（含 attempts、steering 指针）。 */
  executions: readonly TaskExecutionProjection[];
  /** 已接纳任务及其冻结输入（模型配置的唯一权威来源）；可为空（旧数据）。 */
  accepted?: readonly AcceptedTask[];
  /** 验证记录的只读响应投影，已携带 stale/fingerprint 判定。 */
  verifications?: readonly VerificationResponse[];
  /** 费用账本只读行投影；由 T4c 按 session 过滤，模块不查库。 */
  usageEntries?: readonly UsageLedgerEntry[];
}

type GoalItem = HostEvidenceSnapshot['taskGoals'][number];
type SteeringItem = HostEvidenceSnapshot['steeringRelations'][number];
type VerificationItem = HostEvidenceSnapshot['verificationSnapshot'][number];
type ModelConfigItem = HostEvidenceSnapshot['modelConfigs'][number];
type UsageProjection = NonNullable<HostEvidenceSnapshot['usageLedgerProjection']>;

/** 仍在执行队列中的任务在限量保留时优先级最高。 */
const ACTIVE_TASK_STATUSES = new Set(['running', 'queued', 'reconcile_required']);

function compareAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function configuredModelOf(accepted: AcceptedTask): string | undefined {
  if (accepted.input?.version === 2) return accepted.input.executionOptions.model;
  return accepted.request?.options.model;
}

function projectGoals(
  executions: readonly TaskExecutionProjection[],
  context: RedactionContext | undefined
): { items: GoalItem[]; priority: number[] } {
  const byTask = new Map<string, TaskExecutionProjection>();
  for (const projection of executions) {
    if (!byTask.has(projection.task.id)) byTask.set(projection.task.id, projection);
  }
  const projections = [...byTask.values()];

  // 规范（发布/digest）顺序：createdAt、id 升序。
  const canonicalOrder = projections
    .map((projection, index) => ({ projection, index }))
    .sort((x, y) => {
      const byCreated = compareAsc(x.projection.task.createdAt, y.projection.task.createdAt);
      return byCreated !== 0 ? byCreated : compareAsc(x.projection.task.id, y.projection.task.id);
    });

  const items = canonicalOrder.map(({ projection }) => {
    const taskId = projection.task.id;
    const attemptId = projection.task.currentAttemptId ?? null;
    assertSafeIdentity('taskGoals.taskId', taskId, context);
    assertSafeIdentity('taskGoals.attemptId', attemptId, context);
    return {
      taskId,
      attemptId,
      goal: redactExcerpt(projection.task.prompt, context, EXCERPT_BYTES) ?? '',
      // status 来自内部 TaskStatus 枚举，受控非自由文本。
      status: projection.task.status
    } satisfies GoalItem;
  });

  // 限量挑选顺序：当前活跃目标优先，其次最新创建，再按 id 降序，确定性。
  const priority = canonicalOrder
    .map((entry, canonicalIndex) => ({
      canonicalIndex,
      active: ACTIVE_TASK_STATUSES.has(entry.projection.task.status) ? 0 : 1,
      createdAt: entry.projection.task.createdAt,
      id: entry.projection.task.id
    }))
    .sort((x, y) => {
      if (x.active !== y.active) return x.active - y.active;
      const byCreated = compareDesc(x.createdAt, y.createdAt);
      return byCreated !== 0 ? byCreated : compareDesc(x.id, y.id);
    })
    .map(entry => entry.canonicalIndex);

  return { items, priority };
}

function projectSteering(
  executions: readonly TaskExecutionProjection[],
  context: RedactionContext | undefined
): { items: SteeringItem[]; priority: number[] } {
  const byOperation = new Map<string, SteeringOperation>();
  for (const projection of executions) {
    const steering = projection.steering;
    if (steering && !byOperation.has(steering.operationId)) {
      byOperation.set(steering.operationId, steering);
    }
  }
  const operations = [...byOperation.values()];
  const canonicalOrder = operations
    .map((steering, index) => ({ steering, index }))
    .sort((x, y) => {
      const byUpdated = compareAsc(x.steering.updatedAt, y.steering.updatedAt);
      return byUpdated !== 0
        ? byUpdated
        : compareAsc(x.steering.operationId, y.steering.operationId);
    });

  const items = canonicalOrder.map(({ steering }) => {
    assertSafeIdentity('steering.steeringTaskId', steering.taskId, context);
    assertSafeIdentity('steering.targetTaskId', steering.target.taskId, context);
    assertSafeIdentity('steering.targetAttemptId', steering.target.attemptId, context);
    return {
      steeringTaskId: steering.taskId,
      targetTaskId: steering.target.taskId,
      targetAttemptId: steering.target.attemptId,
      // delivered 仅表示指令投递完成，不是一次独立模型成功轮次。
      completed: steering.state === 'delivered'
    } satisfies SteeringItem;
  });

  const priority = canonicalOrder
    .map((entry, canonicalIndex) => ({
      canonicalIndex,
      updatedAt: entry.steering.updatedAt,
      id: entry.steering.operationId
    }))
    .sort((x, y) => {
      const byUpdated = compareDesc(x.updatedAt, y.updatedAt);
      return byUpdated !== 0 ? byUpdated : compareDesc(x.id, y.id);
    })
    .map(entry => entry.canonicalIndex);

  return { items, priority };
}

interface UnrelatableVerification {
  id: string;
  passed: boolean;
  stale: boolean;
  summary?: string;
}

function projectVerifications(
  verifications: readonly VerificationResponse[],
  context: RedactionContext | undefined
): {
  items: VerificationItem[];
  priority: number[];
  unrelatable: UnrelatableVerification[];
} {
  const sorted = [...verifications].sort((a, b) => {
    const byStarted = compareAsc(a.startedAt, b.startedAt);
    return byStarted !== 0 ? byStarted : compareAsc(a.id, b.id);
  });

  const items: VerificationItem[] = [];
  const unrelatable: UnrelatableVerification[] = [];
  for (const record of sorted) {
    // 命令行可能携带凭据/flag，错误文本是 native 可控字符串，均脱敏限长。
    const rawSummary = record.error ?? record.command;
    const summary = rawSummary
      ? redactExcerpt(rawSummary, context, EXCERPT_BYTES) ?? undefined
      : undefined;
    if (!record.taskId) {
      // 无法关联任务，schema 无法承载；仍进全量 digest 与 omitted 计数。
      unrelatable.push({
        id: record.id,
        passed: record.status === 'passed',
        stale: record.stale,
        ...(summary !== undefined ? { summary } : {})
      });
      continue;
    }
    assertSafeIdentity('verification.taskId', record.taskId, context);
    items.push({
      taskId: record.taskId,
      attemptId: null,
      // 只认真实记录的 passed；prompt/test 关键词不参与判定。
      passed: record.status === 'passed',
      // stale（含缺 fingerprint、运行中代码变更）由宿主验证层判定，原样保留。
      stale: record.stale,
      ...(summary !== undefined ? { summary } : {})
    });
  }

  // 限量挑选顺序：最新开始的验证优先（items 已按 startedAt、id 升序）。
  const priority = items.map((_, index) => index).reverse();

  return { items, priority, unrelatable };
}

function projectModelConfigs(
  accepted: readonly AcceptedTask[],
  context: RedactionContext | undefined
): { items: ModelConfigItem[]; priority: number[] } {
  const byTask = new Map<string, AcceptedTask>();
  for (const value of accepted) {
    if (!byTask.has(value.task.id)) byTask.set(value.task.id, value);
  }
  const values = [...byTask.values()];
  const canonicalOrder = values
    .map((value, index) => ({ value, index }))
    .sort((x, y) => {
      const byUpdated = compareAsc(x.value.task.updatedAt, y.value.task.updatedAt);
      return byUpdated !== 0 ? byUpdated : compareAsc(x.value.task.id, y.value.task.id);
    });

  const items: ModelConfigItem[] = [];
  // 仅保留有冻结模型的条目，同时记录其在 items 内的规范序与挑选序。
  const keptCanonical: Array<{ canonicalIndex: number; updatedAt: string; id: string }> = [];
  canonicalOrder.forEach(({ value }, canonicalIndex) => {
    const model = configuredModelOf(value);
    if (!model) return;
    assertSafeIdentity('modelConfigs.taskId', value.task.id, context);
    items.push({
      taskId: value.task.id,
      // 配置在任务接受时冻结，不从属某个 attempt；不给当前 session 模型。
      attemptId: null,
      configuredModel: truncateUtf8Bytes(redactText(model, context), EXCERPT_BYTES)
    });
    keptCanonical.push({
      canonicalIndex: items.length - 1,
      updatedAt: value.task.updatedAt,
      id: value.task.id
    });
  });

  // 最新更新任务的模型配置优先。
  const priority = keptCanonical
    .slice()
    .sort((x, y) => {
      const byUpdated = compareDesc(x.updatedAt, y.updatedAt);
      return byUpdated !== 0 ? byUpdated : compareDesc(x.id, y.id);
    })
    .map(entry => entry.canonicalIndex);

  return { items, priority };
}

function projectUsage(entries: readonly UsageLedgerEntry[]): UsageProjection {
  let start: string | null = null;
  let end: string | null = null;
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const ms = Date.parse(entry.recordedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms < startMs) {
      startMs = ms;
      start = entry.recordedAt;
    }
    if (ms > endMs) {
      endMs = ms;
      end = entry.recordedAt;
    }
  }

  const projection: UsageProjection = {
    recordedAtRange: { start, end },
    hasUnpricedUsage: false
  };

  if (entries.length === 0) return projection;

  // 有 token 用量却缺价格（账本未计价或字段缺失）时，合计成本未知而非 0。
  const hasUnpricedUsage = entries.some(
    entry =>
      entry.dataStatus === 'unpriced' ||
      (entry.dataStatus !== 'unavailable' && typeof entry.costUsd !== 'number')
  );
  projection.hasUnpricedUsage = hasUnpricedUsage;

  if (hasUnpricedUsage) {
    projection.totalCostEstimate = null;
    projection.currency = null;
  } else {
    const priced = entries.filter(
      entry => entry.dataStatus !== 'unavailable' && typeof entry.costUsd === 'number'
    );
    if (priced.length > 0) {
      const sum = priced.reduce((acc, entry) => acc + (entry.costUsd as number), 0);
      projection.totalCostEstimate = Math.round(sum * 1e6) / 1e6;
      projection.currency = 'USD';
    }
    // 全部 unavailable（无真实用量）时不给 totalCostEstimate：未知，不是 0。
  }

  return projection;
}

/**
 * 对业务证据做确定性 SHA256：
 * - 调用方应传入「限量前的全量已脱敏事实」，被省略条目变化也会改变 digest；
 * - 不含 capturedAt / digest；canonicalExecutionJson 排序对象键，键序无关；
 * - 数组须为规范升序（各投影函数已保证）。
 */
export function computeHostEvidenceDigest(businessFacts: object): string {
  return createHash('sha256').update(canonicalExecutionJson(businessFacts)).digest('hex');
}

interface ClassSpec {
  includeKey: 'taskGoals' | 'verificationSnapshot' | 'steeringRelations' | 'modelConfigs';
  omitKey:
    | 'omittedGoalsCount'
    | 'omittedVerificationsCount'
    | 'omittedSteeringCount'
    | 'omittedModelConfigsCount';
  items: Array<Record<string, unknown>>;
  /** 限量挑选顺序：值为 items 的下标，活跃/最新在前。 */
  priority: readonly number[];
  /** 该类独立字节预算；Infinity 表示 goals（吃总预算扣除侧类后的剩余）。 */
  budgetBytes: number;
  /** 与列表限量无关、结构性无法承载的省略（无 taskId 的验证记录）。 */
  forcedOmitted: number;
}

/**
 * 从冻结的权威原始投影生成 HostEvidenceSnapshot。
 * 纯函数：不读源、不修改输入；结果通过 hostEvidenceSnapshotSchema 校验，
 * 整体 UTF-8 字节不超过 512 KiB。侧类有固定预算保证关键证据非空，goals 吃剩余。
 */
export function buildHostEvidenceSnapshot(
  input: HostEvidenceInput,
  context?: RedactionContext
): HostEvidenceSnapshot {
  const goals = projectGoals(input.executions ?? [], context);
  const steering = projectSteering(input.executions ?? [], context);
  const verifications = projectVerifications(input.verifications ?? [], context);
  const models = projectModelConfigs(input.accepted ?? [], context);
  const usageProjection = projectUsage(input.usageEntries ?? []);

  const specs: ClassSpec[] = [
    {
      includeKey: 'verificationSnapshot',
      omitKey: 'omittedVerificationsCount',
      items: verifications.items,
      priority: verifications.priority,
      budgetBytes: VERIFICATION_BUDGET_BYTES,
      forcedOmitted: verifications.unrelatable.length
    },
    {
      includeKey: 'steeringRelations',
      omitKey: 'omittedSteeringCount',
      items: steering.items,
      priority: steering.priority,
      budgetBytes: STEERING_BUDGET_BYTES,
      forcedOmitted: 0
    },
    {
      includeKey: 'modelConfigs',
      omitKey: 'omittedModelConfigsCount',
      items: models.items,
      priority: models.priority,
      budgetBytes: MODEL_BUDGET_BYTES,
      forcedOmitted: 0
    },
    {
      includeKey: 'taskGoals',
      omitKey: 'omittedGoalsCount',
      items: goals.items,
      priority: goals.priority,
      budgetBytes: Number.POSITIVE_INFINITY,
      forcedOmitted: 0
    }
  ];

  const selectedIndices = new Map<ClassSpec, Set<number>>();
  specs.forEach(spec => selectedIndices.set(spec, new Set<number>()));

  const itemBytes = (spec: ClassSpec, index: number): number =>
    Buffer.byteLength(canonicalExecutionJson(spec.items[index]), 'utf8') + 1;

  // 空信封字节（含全部计数位与 usage）；后续按实际选中条目累加。
  const envelopeBytes = (extra: Record<string, number>): number =>
    Buffer.byteLength(
      canonicalExecutionJson({
        capturedAt: input.capturedAt,
        taskGoals: [],
        omittedGoalsCount: extra.omittedGoalsCount ?? 0,
        steeringRelations: [],
        omittedSteeringCount: extra.omittedSteeringCount ?? 0,
        verificationSnapshot: [],
        omittedVerificationsCount: extra.omittedVerificationsCount ?? 0,
        modelConfigs: [],
        omittedModelConfigsCount: extra.omittedModelConfigsCount ?? 0,
        usageLedgerProjection: usageProjection,
        digest: PLACEHOLDER_DIGEST
      }),
      'utf8'
    );

  let usedBytes = envelopeBytes({}) + BUDGET_SLACK_BYTES;

  // 先填三类有固定预算的关键证据（按各自最新优先顺序）。
  for (const spec of specs.slice(0, 3)) {
    let classBytes = 0;
    const chosen = selectedIndices.get(spec)!;
    for (const index of spec.priority) {
      const bytes = itemBytes(spec, index);
      if (classBytes + bytes > spec.budgetBytes) break;
      if (usedBytes + bytes > HOST_EVIDENCE_BYTES) break;
      classBytes += bytes;
      usedBytes += bytes;
      chosen.add(index);
    }
  }

  // goals 只吃剩余预算（活跃/最新优先）。
  const goalSpec = specs[3]!;
  const chosenGoals = selectedIndices.get(goalSpec)!;
  for (const index of goalSpec.priority) {
    const bytes = itemBytes(goalSpec, index);
    if (usedBytes + bytes > HOST_EVIDENCE_BYTES) break;
    usedBytes += bytes;
    chosenGoals.add(index);
  }

  // 组装发布结果：被选条目回到规范升序；计数 = 全量 - 保留 + 结构性省略。
  const includedArrays: Record<string, Array<Record<string, unknown>>> = {
    taskGoals: [],
    verificationSnapshot: [],
    steeringRelations: [],
    modelConfigs: []
  };
  const omittedCounts: Record<string, number> = {};
  for (const spec of specs) {
    const chosen = selectedIndices.get(spec)!;
    includedArrays[spec.includeKey] = spec.items.filter((_, index) => chosen.has(index));
    omittedCounts[spec.omitKey] = spec.items.length - chosen.size + spec.forcedOmitted;
  }

  const parsed = hostEvidenceSnapshotSchema.parse({
    capturedAt: input.capturedAt,
    taskGoals: includedArrays.taskGoals,
    omittedGoalsCount: omittedCounts.omittedGoalsCount,
    steeringRelations: includedArrays.steeringRelations,
    omittedSteeringCount: omittedCounts.omittedSteeringCount,
    verificationSnapshot: includedArrays.verificationSnapshot,
    omittedVerificationsCount: omittedCounts.omittedVerificationsCount,
    modelConfigs: includedArrays.modelConfigs,
    omittedModelConfigsCount: omittedCounts.omittedModelConfigsCount,
    usageLedgerProjection: usageProjection,
    digest: PLACEHOLDER_DIGEST
  });

  // digest 对限量前全量已脱敏事实取指纹（含最终被省略的条目与无法关联的验证）。
  const digestFacts = {
    taskGoals: goals.items,
    steeringRelations: steering.items,
    verificationSnapshot: verifications.items,
    verificationUnrelatable: verifications.unrelatable,
    modelConfigs: models.items,
    usageLedgerProjection: usageProjection
  };
  const digest = computeHostEvidenceDigest(digestFacts);
  const result: HostEvidenceSnapshot = { ...parsed, digest };

  const finalBytes = Buffer.byteLength(canonicalExecutionJson(result), 'utf8');
  if (finalBytes > HOST_EVIDENCE_BYTES) {
    // 确定性预算算法下不应发生；发生即拒绝发布，绝不悄悄截断。
    throw new Error(`HOST_EVIDENCE_BUDGET_EXCEEDED: ${finalBytes} > ${HOST_EVIDENCE_BYTES}`);
  }
  return result;
}
