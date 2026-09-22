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
