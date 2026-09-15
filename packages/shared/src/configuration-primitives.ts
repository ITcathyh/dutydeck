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
