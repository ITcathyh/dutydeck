import { redactCredentialText } from './credential-redaction.js';

/** Redact before truncating so a clipped credential cannot escape the matching rule. */
export function permissionDisplayText(value: unknown, secrets: string[] = [], limit = 1200): string {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  text = redactCredentialText(text, '[REDACTED]', '[REDACTED]')
    .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w-]*)["']?\s*(?:[:=]\s*|\s+))(?:("[^"\n]*"|'[^'\n]*')|[^\s;&]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,})\b/gi, '[REDACTED]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 用户拒绝审批时附带说明的长度上限（去控制字符、去首尾空白之后计）。 */
export const permissionRejectReasonMaxLength = 2000;

/** 「拒绝并说明」输入框提示；Web 审批卡、收件箱和飞书审批卡共用。ACP 驱动回执只有 reject_once，原因送不到 Agent。 */
export const permissionRejectReasonHint = '原因会记录在审批历史；终端模式的 Agent 会收到原因，ACP 模式的 Agent 只知道被拒绝。';

/** 去掉控制字符（保留换行与制表符）和首尾空白；空串返回 undefined，表示没有说明。 */
export function cleanPermissionRejectReason(value: string): string | undefined {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim() || undefined;
}
