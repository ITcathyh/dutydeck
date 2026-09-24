import { z } from 'zod';
import type { AttemptResultV1 } from './task-execution.js';

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
}
export interface WorkTemplate { id: string; parentSessionId: string; name: string; version: number; plan: WorkPlan; createdAt: string }
/**
 * 编排闸门的默认判定：群聊里 Agent 提出的计划必须先给人确认，
 * 单聊只有发起人自己在场、下一句就能改口，默认直接执行。
 * 人手输入的命令由调用方显式覆盖，不走这里。
 */
export function workPlanConfirmationRequired(session: { source?: string | null; sourceId?: string | null }): boolean {
  return session.source === 'lark' && (session.sourceId ?? '').split(':')[2] === 'group';
}
