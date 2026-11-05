import { z } from 'zod';
import type { AttemptResultV1 } from './task-execution.js';
import { parseLarkSourceId } from './lark-source-id.js';

const stepId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const workStepDefinitionSchema = z.object({
  id: stepId,
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['agent', 'wait']),
  agentId: z.string().trim().min(1).optional(),
  instruction: z.string().trim().min(1).max(32_000),
  dependsOn: z.array(stepId).max(12),
  workspaceMode: z.enum(['shared', 'worktree']).optional(),
  skills: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  reviewPolicy: z.object({
    maxReworkRounds: z.number().int().min(0).max(3),
    allowedTargetStepIds: z.array(stepId).min(1).max(11)
  }).strict().optional(),
  when: z.object({ stepId, equals: z.string().min(1).max(4_000) }).strict().optional()
}).strict();
export type WorkStepDefinition = z.infer<typeof workStepDefinitionSchema>;
export const workPlanSchema = z.object({
  title: z.string().trim().min(1).max(200),
  steps: z.array(workStepDefinitionSchema).min(1).max(12),
  outputStepId: stepId
}).strict().superRefine((plan, ctx) => {
  const ids = new Map(plan.steps.map(step => [step.id, step]));
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (ids.size !== plan.steps.length) invalid('Step IDs must be unique');
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const dependency of ids.get(id)?.dependsOn ?? []) ancestors(dependency, seen);
    return seen;
  };
  for (const step of plan.steps) {
    if (step.kind === 'agent' && !step.agentId) invalid(`Agent step ${step.id} requires agentId`);
    if (new Set(step.dependsOn).size !== step.dependsOn.length) invalid(`Duplicate dependencies on ${step.id}`);
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) invalid(`Unknown dependency ${dependency}`);
      if (ancestors(dependency).has(step.id)) invalid('Plan must be acyclic');
    }
    if (step.when && (ids.get(step.when.stepId)?.kind !== 'wait' || !step.dependsOn.some(id => ancestors(id).has(step.when!.stepId)))) {
      invalid(`Condition on ${step.id} must reference an upstream wait`);
    }
  }
  const output = ids.get(plan.outputStepId);
  if (output?.kind !== 'agent' || output.when) invalid('Output must be an unconditional agent step');
  for (const step of plan.steps.filter(step => step.reviewPolicy)) {
    if (step.id !== plan.outputStepId) invalid('Only the output step can review');
    const targets = step.reviewPolicy!.allowedTargetStepIds;
    if (new Set(targets).size !== targets.length) invalid('Review targets must be unique');
    for (const id of targets) {
      const target = ids.get(id);
      if (!target || target.kind !== 'agent' || target.when || target.id === step.id || target.agentId === step.agentId || !step.dependsOn.includes(id)
        || plan.steps.some(other => other.id !== step.id && other.dependsOn.includes(id))) {
        invalid(`Review target ${id} must be an unconditional terminal worker assigned to a different Agent`);
      }
    }
  }
  const reachable = ancestors(plan.outputStepId);
  if (plan.steps.some(step => !reachable.has(step.id))) invalid('Every step must contribute to the output');
});
export type WorkPlan = z.infer<typeof workPlanSchema>;
export const createWorkItemSchema = z.object({
  goal: z.string().trim().min(1).max(32_000),
  plan: workPlanSchema,
  idempotencyKey: z.string().trim().min(1).max(200)
}).strict();
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;
export const workReviewVerdictSchema = z.object({
  decision: z.enum(['accept', 'rework', 'stop']),
  reviewed: z.array(z.object({ stepId, attemptId: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(11),
  targetStepId: stepId.optional(),
  feedback: z.string().trim().min(1).max(16_000)
}).strict().superRefine((verdict, ctx) => {
  if ((verdict.decision === 'rework') !== Boolean(verdict.targetStepId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only rework requires targetStepId' });
});
export type WorkReviewVerdict = z.infer<typeof workReviewVerdictSchema>;
export type WorkItemBlockReason = 'reconcile_required' | 'legacy_output_unresolved' | 'legacy_input_unresolved' | 'admission_conflict';
export interface WorkAttempt {
  id: string; number: number; sessionId?: string; taskId?: string;
  status: 'preparing' | 'accepted' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'blocked';
  runtimeAttemptId?: string;
  result?: AttemptResultV1;
  /** Structured review evidence; the original generated JSON remains in output/result. */
  review?: WorkReviewVerdict;
  resultBoundary?: 'verified' | 'legacy_output_unresolved';
  blockReason?: WorkItemBlockReason;
  output?: { text: string; digest: string }; error?: string; createdAt: string; updatedAt: string;
  /** 计划修订作废了这次尝试：结果不再作为下游输入，也不计入重试与返工次数。 */
  supersededByPlanVersion?: number;
}
export interface WorkStep {
  id: string; status: 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'cancelled' | 'blocked';
  attempts: WorkAttempt[]; answer?: string;
}
export interface WorkItem {
  id: string; parentSessionId: string; title: string; goal: string; revision: number;
  /** awaiting_confirmation：计划已持久接收但尚未入队，等人工确认后才允许派发任何步骤。 */
  status: 'awaiting_confirmation' | 'running' | 'waiting' | 'failed' | 'completed' | 'cancelling' | 'cancelled' | 'blocked';
  plan: WorkPlan; steps: WorkStep[]; createdAt: string; updatedAt: string;
  output?: { text: string; digest: string; stepId: string }; error?: string;
  delivery: { status: 'pending' | 'delivered' | 'error' | 'not_requested'; attempts: number; error?: string };
  /** 当前生效的计划版本；旧记录缺省为 1。 */
  planVersion?: number;
  /** 每个生效过的计划版本，按版本号递增；旧记录缺省时只有创建时的版本 1。 */
  planHistory?: WorkPlanVersion[];
  /** Agent 提交、等待人工确认的修订；确认前计划冻结在当前版本，已生效的步骤照常调度，状态不因此改变。 */
  pendingRevision?: PendingWorkRevision;
  /** 被修订删除的步骤，保留尝试记录与子会话归属，不再参与调度。 */
  retiredSteps?: WorkStep[];
}
/**
 * 修订影响：keep 原样保留（含已完成结果）；rerun 作废结果后重跑；
 * stop 是 rerun/remove 中正在运行、必须先证明已停止的步骤；discard 是 rerun/remove 中已完成、结果将被作废的步骤；
 * remove 删除；add 新增。stop 与 discard 随步骤状态变化，旧记录没有 discard。
 */
export interface WorkRevisionImpact { keep: string[]; rerun: string[]; stop: string[]; discard?: string[]; remove: string[]; add: string[] }
export interface WorkPlanVersion {
  version: number; plan: WorkPlan; createdAt: string;
  /** create：创建时的计划；human：有操作权限的人提交；agent：Agent 经 dutydeck work 提交（可能经人工确认）。 */
  source: 'create' | 'human' | 'agent';
  /** 提交或确认修订的人：目标创建人或安装管理员；不暴露平台用户 ID。 */
  actor?: 'creator' | 'installation_owner';
  reason?: string; impact?: WorkRevisionImpact;
}
export interface PendingWorkRevision {
  version: number; plan: WorkPlan; requestedAt: string; source: 'agent'; reason?: string;
  impact: WorkRevisionImpact; confirmationReasons: string[];
  /** 修订内容摘要（版本、计划、原因、影响与确认原因）；确认或放弃时用它锁定所见内容，Agent 替换修订或影响重算后摘要随之变化。 */
  digest: string;
  /** 影响重算后，确认者已在卡片上看到过会被停止或作废结果的步骤；缺省为当前影响里的 stop 与 discard。 */
  acknowledged?: string[];
}
export const reviseWorkPlanSchema = z.object({
  expectedRevision: z.number().int().positive(),
  plan: workPlanSchema,
  reason: z.string().trim().min(1).max(2_000).optional()
}).strict();
export type ReviseWorkPlanInput = z.infer<typeof reviseWorkPlanSchema>;
export interface WorkRevisionPreview { revision: number; planVersion: number; nextVersion: number; impact: WorkRevisionImpact; requiresConfirmation: boolean; confirmationReasons: string[] }

/** 键序无关、忽略 undefined 字段的 JSON 规范形式，用于比较计划和计算修订摘要。 */
export const canonicalPlanJson = (value: unknown): string => JSON.stringify(canonical(value));
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const sameJson = (left: unknown, right: unknown) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const normalizedStep = (step: WorkStepDefinition) => ({ ...step, workspaceMode: step.kind === 'agent' ? step.workspaceMode ?? 'shared' : step.workspaceMode, skills: step.skills ?? [] });

/**
 * 受影响 = 新增或任一字段（指令、Agent、依赖、条件、验收策略等）变化的步骤，加上它们在新计划里的全部下游。
 * 被删步骤的下游必然改了依赖，因此也在受影响之列。
 */
export function analyzeWorkPlanRevision(current: { plan: WorkPlan; steps: Pick<WorkStep, 'id' | 'status'>[] }, next: WorkPlan): WorkRevisionImpact {
  const before = new Map(current.plan.steps.map(step => [step.id, step]));
  const after = new Map(next.steps.map(step => [step.id, step]));
  const status = new Map(current.steps.map(step => [step.id, step.status]));
  const affected = new Set(next.steps.filter(step => !before.has(step.id) || !sameJson(normalizedStep(before.get(step.id)!), normalizedStep(step))).map(step => step.id));
  for (let grew = true; grew;) {
    grew = false;
    for (const step of next.steps) if (!affected.has(step.id) && step.dependsOn.some(id => affected.has(id))) { affected.add(step.id); grew = true; }
  }
  const remove = current.plan.steps.filter(step => !after.has(step.id)).map(step => step.id);
  const add = next.steps.filter(step => !before.has(step.id)).map(step => step.id);
  const rerun = next.steps.filter(step => before.has(step.id) && affected.has(step.id)).map(step => step.id);
  return {
    keep: next.steps.filter(step => before.has(step.id) && !affected.has(step.id)).map(step => step.id),
    rerun, add, remove,
    stop: [...rerun, ...remove].filter(id => status.get(id) === 'running'),
    discard: [...rerun, ...remove].filter(id => status.get(id) === 'completed')
  };
}

/**
 * Agent 自行修订时只允许收窄：改未失败步骤的标题/指令、删除不带审查的 Agent 步骤、增加依赖、减少 Skill。
 * 其余变化（新增步骤或 Agent、换 Agent、扩大 Skill、改工作区、条件或审查、去掉依赖、删除人工等待或审查步骤、
 * 更换最终输出步骤、让已失败步骤自动重跑）都要人工确认。重跑已失败步骤会绕过人工重试和重试上限，所以单列。
 */
export function workRevisionConfirmationReasons(current: { plan: WorkPlan; steps: Pick<WorkStep, 'id' | 'status'>[] }, next: WorkPlan): string[] {
  const reasons: string[] = [];
  const before = new Map(current.plan.steps.map(step => [step.id, step]));
  const after = new Set(next.steps.map(step => step.id));
  const knownAgents = new Set(current.plan.steps.map(step => step.agentId).filter(Boolean));
  for (const step of next.steps) {
    const old = before.get(step.id);
    if (!old) { reasons.push(`新增步骤 ${step.id}${step.agentId && !knownAgents.has(step.agentId) ? `（新 Agent ${step.agentId}）` : ''}`); continue; }
    if (old.kind !== step.kind || old.agentId !== step.agentId) reasons.push(`步骤 ${step.id} 更换执行者`);
    if ((step.skills ?? []).some(skill => !(old.skills ?? []).includes(skill))) reasons.push(`步骤 ${step.id} 新增 Skill`);
    if ((old.workspaceMode ?? 'shared') !== (step.workspaceMode ?? 'shared')) reasons.push(`步骤 ${step.id} 改变工作区模式`);
    if (!sameJson(old.when, step.when)) reasons.push(`步骤 ${step.id} 改变执行条件`);
    if (!sameJson(old.reviewPolicy, step.reviewPolicy)) reasons.push(`步骤 ${step.id} 改变审查策略`);
    const dropped = old.dependsOn.filter(id => after.has(id) && !step.dependsOn.includes(id));
    if (dropped.length) reasons.push(`步骤 ${step.id} 去掉依赖 ${dropped.join('、')}`);
  }
  for (const step of current.plan.steps) if (!after.has(step.id) && step.kind === 'wait') reasons.push(`删除人工等待 ${step.id}`);
  for (const step of current.plan.steps) if (!after.has(step.id) && step.reviewPolicy) reasons.push(`删除带审查策略的步骤 ${step.id}`);
  if (current.plan.outputStepId !== next.outputStepId) reasons.push(`最终输出步骤由 ${current.plan.outputStepId} 改为 ${next.outputStepId}`);
  const failed = new Set(current.steps.filter(step => step.status === 'failed').map(step => step.id));
  for (const id of analyzeWorkPlanRevision(current, next).rerun) if (failed.has(id)) reasons.push(`重跑已失败的步骤 ${id}`);
  return reasons;
}
export interface WorkTemplate { id: string; parentSessionId: string; name: string; version: number; plan: WorkPlan; createdAt: string }
/**
 * 编排闸门的默认判定：群聊里 Agent 提出的计划必须先给人确认，
 * 单聊只有发起人自己在场、下一句就能改口，默认直接执行。
 * 人手输入的命令由调用方显式覆盖，不走这里。
 */
export function workPlanConfirmationRequired(session: { source?: string | null; sourceId?: string | null }): boolean {
  return session.source === 'lark' && parseLarkSourceId(session.sourceId).chatType === 'group';
}
