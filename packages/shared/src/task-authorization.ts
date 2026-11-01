import { z } from 'zod';

export const taskAuthorizationWays = ['mention', 'direct', 'topic_followup', 'answer_reply', 'participation_act', 'participation_confirmed', 'addressed', 'scenario_direct', 'command', 'task_channel', 'group_rule', 'schedule', 'automation'] as const;
export const taskAuthorizationSourceSchema = z.object({
  strength: z.enum(['explicit', 'inferred']),
  via: z.enum(taskAuthorizationWays),
  decisionId: z.string().min(1).optional(),
  policyVersion: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().min(1)).optional()
}).strict();
export const taskAuthorizationSchema = taskAuthorizationSourceSchema.extend({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  actorOpenId: z.string().min(1).optional(),
  chatId: z.string().min(1).optional(),
  recordedAt: z.string().datetime()
}).strict();
export type TaskAuthorizationSource = z.infer<typeof taskAuthorizationSourceSchema>;
export type TaskAuthorization = z.infer<typeof taskAuthorizationSchema>;
