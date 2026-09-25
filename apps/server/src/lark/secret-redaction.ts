/**
 * 执行记录与记忆共用的凭据脱敏规则：卡片渲染用 redactTraceText 抹掉凭据，
 * 会话记忆用它判断一段内容是否疑似含凭据（会被改写即算）。
 *
 * 单独成文件是为了保持纯函数、零依赖：card-renderer.ts 会把 service.ts 整条网络层带进来，
 * memory.ts 这类纯模块不能 import 它。
 */
export const sensitiveTraceKey = /(?:authorization|api[_-]?key|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)$/i;
export const redactTraceText = (value: string) => value
  // Treat a truncated PEM as sensitive through end-of-input; logs often cut
  // output before the END marker arrives.
  .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
  // URL userinfo can contain both a user name and password. Keep only the destination URL shape.
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
  // Authorization is handled before generic assignments so "Bearer token" is removed as one value.
  .replace(/(\bauthorization\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n"',;&}]+)/gi, '$1[REDACTED]')
  .replace(/\bbearer\s+[^"'\s,;}&]+/gi, 'Bearer [REDACTED]')
  .replace(/(--turn(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&]+)/g, '$1[REDACTED]')
  // Common CLI flags use a following argument instead of key=value.
  .replace(/(^|[^A-Za-z0-9_-])((?:--?)(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)\s+)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gim, '$1$2[REDACTED]')
  .replace(/((?:\b(?:api[_-]?key|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)|\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|API_KEY)[A-Z0-9_]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[REDACTED]');
