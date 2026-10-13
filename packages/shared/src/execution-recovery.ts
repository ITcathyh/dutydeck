import { z } from 'zod';
import { taskExecutionSchemas } from './task-execution.js';

const scope = {
  runId: z.string().min(1), taskId: z.string().min(1), attemptId: z.string().min(1),
  expectedRevision: z.number().int().positive(), decisionId: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1), resourceChecks: taskExecutionSchemas.checksSchema
};
export const executionRecoveryDecisionSchema = z.discriminatedUnion('action', [
  z.object({ ...scope, action: z.literal('confirm_result'), outcome: z.enum(['completed', 'failed', 'interrupted', 'cancelled', 'unknown']), verifiedOutputText: z.string().optional() }).strict(),
  z.object({ ...scope, action: z.literal('retry'), allowDuplicateEffects: z.literal(true) }).strict()
]).superRefine((input, ctx) => {
  if (input.action !== 'confirm_result') return;
  if ((input.outcome === 'completed') !== (input.verifiedOutputText !== undefined)) ctx.addIssue({ code: 'custom', path: ['verifiedOutputText'], message: 'Completed recovery requires verified output; other outcomes must omit it' });
  if (input.verifiedOutputText !== undefined && new TextEncoder().encode(input.verifiedOutputText).length > 512 * 1024) ctx.addIssue({ code: 'custom', path: ['verifiedOutputText'], message: 'Verified output exceeds 512 KiB' });
});
export type ExecutionRecoveryDecision = z.infer<typeof executionRecoveryDecisionSchema>;

export const nativeReplacementRecoverySchema = z.object({
  runId: z.string().min(1), resourceId: z.string().min(1), expectedRevision: z.number().int().positive().safe(), decisionId: z.string().min(1)
}).strict();
export const ptyRetirementRecoverySchema = nativeReplacementRecoverySchema.extend({ evidenceRefs: z.array(z.string().min(1)).min(1) }).strict();
export type PtyRetirementRecovery = z.infer<typeof ptyRetirementRecoverySchema>;

const steeringScope = {
  runId: z.string().min(1), taskId: z.string().min(1), operationId: z.string().min(1),
  expectedRevision: z.number().int().positive().safe(), decisionId: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1), resourceChecks: taskExecutionSchemas.checksSchema
};
/** not_delivered authorizes a new dispatch; it does not prove the previous dispatch had no effects. */
export const steeringRecoveryDecisionSchema = z.discriminatedUnion('action', [
  z.object({ ...steeringScope, action: z.literal('delivered') }).strict(),
  z.object({ ...steeringScope, action: z.literal('not_delivered'), allowDuplicateEffects: z.literal(true) }).strict(),
  z.object({ ...steeringScope, action: z.literal('abandon') }).strict()
]);
export type SteeringRecoveryDecision = z.infer<typeof steeringRecoveryDecisionSchema>;

/**
 * 结果未知的任务由人处理（飞书卡片、Web）：重新执行、标为已完成、标为失败。
 * target 是处理时看到的那次执行（attemptId）或那次插话（operationId）；已经换了一次执行的旧卡不会作用到新的执行上。
 * decisionId 由调用方按「目标 + 动作 + 操作人」生成：同一人同一动作的重复提交只回放，别的提交被版本号挡住。
 */
export const unknownTaskResolutionSchema = z.object({
  taskId: z.string().min(1), target: z.string().min(1), decisionId: z.string().min(1),
  action: z.enum(['retry', 'completed', 'failed']),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  verifiedOutputText: z.string().optional(),
  allowDuplicateEffects: z.literal(true).optional()
}).strict().superRefine((input, ctx) => {
  if (input.action === 'retry' && input.allowDuplicateEffects !== true) ctx.addIssue({ code: 'custom', path: ['allowDuplicateEffects'], message: 'Retry requires explicit duplicate-effects acknowledgement' });
  if (input.verifiedOutputText !== undefined && new TextEncoder().encode(input.verifiedOutputText).length > 512 * 1024) ctx.addIssue({ code: 'custom', path: ['verifiedOutputText'], message: 'Verified output exceeds 512 KiB' });
});
export type UnknownTaskResolution = z.infer<typeof unknownTaskResolutionSchema>;
export type UnknownTaskAction = UnknownTaskResolution['action'];
export const unknownTaskActionLabels: Record<UnknownTaskAction, string> = { retry: '重新执行', completed: '标为已完成', failed: '标为失败' };
/** 重新执行之前要读者确认的那句话：飞书提醒卡、确认提示与 Web 确认框共用。 */
export const unknownTaskRetryWarning = '重新执行会按原请求再做一遍。上一轮可能已经做过其中一部分（发消息、改文件、调接口等），这些操作可能被重复执行。';

/** 结果未知任务的已知事实：只读投影，不含进程或控制器标识。 */
export interface UnknownTaskFacts {
  taskId: string; status: string;
  /** 现在能不能处理：这一轮的执行停在结果未知，或插话投递结果未知。 */
  actionable: boolean;
  kind?: 'attempt' | 'steering';
  /** 当前（或调用方指定的）那次执行 / 插话。 */
  target?: string;
  /** 有没有提交给 Agent：not_submitted 没有；intent_recorded 已开始提交、没收到确认；acknowledged 已确认收到。插话没有这一项。 */
  submission?: 'not_submitted' | 'intent_recorded' | 'acknowledged' | 'legacy_unknown';
  reasonCode?: string;
  startedAt?: string;
  /** 这次执行最后一条输出的时间；没有输出时不给。 */
  lastOutputAt?: string;
  /** target 已被人工处理过：哪一个动作、哪个决定、什么时候。other 是别的流程（如飞书「放弃」）记下的结果未知。 */
  resolution?: { action: UnknownTaskAction | 'other'; decisionId: string; at: string };
}
