import { z } from 'zod';
import safeRegex from 'safe-regex2';

export const highRiskPatternMaxLength = 4_096;
export type RegexPatternValidation = { valid: true } | { valid: false; error: string };

export function validateHighRiskPattern(pattern: string): RegexPatternValidation {
  if (!pattern.trim()) return { valid: false, error: '请输入高危操作正则表达式' };
  if (pattern.length > highRiskPatternMaxLength) {
    return { valid: false, error: `正则表达式不能超过 ${highRiskPatternMaxLength} 个字符` };
  }
  try {
    new RegExp(pattern, 'i');
  } catch (error) {
    return { valid: false, error: `正则表达式语法错误：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!safeRegex(pattern)) {
    return { valid: false, error: '正则表达式可能造成灾难性回溯，请移除嵌套量词或拆分复杂表达式' };
  }
  return { valid: true };
}

export const permissionModes = ['ask', 'approve-reads', 'deny-all', 'full-trust'] as const;
export type PermissionMode = (typeof permissionModes)[number];

export const channelBotBrands = ['feishu', 'lark'] as const;
export type ChannelBotBrand = (typeof channelBotBrands)[number];

/** Relative probabilities for new primary Lark sessions; an empty list disables routing. */
export const agentWeightsSchema = z.array(z.object({
  agentId: z.string().trim().min(1),
  weight: z.number().finite().positive()
}).strict()).superRefine((rows, context) => {
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (ids.has(row.agentId)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'agentId'], message: 'Duplicate Agent' });
    ids.add(row.agentId);
  }
  if (!Number.isFinite(rows.reduce((total, row) => total + row.weight, 0))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Total weight must be finite' });
});
export type AgentWeight = z.infer<typeof agentWeightsSchema>[number];
