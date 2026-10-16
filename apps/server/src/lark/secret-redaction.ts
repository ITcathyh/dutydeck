/**
 * 执行记录、记忆和 Agent 主动发出的群消息共用的凭据脱敏规则：卡片渲染和群工具发送用 redactTraceText 抹掉凭据，
 * 会话记忆用它判断一段内容是否疑似含凭据（会被改写即算）。
 *
 * 单独成文件是为了零依赖：card-renderer.ts 会把 service.ts 整条网络层带进来，
 * memory.ts 这类纯模块不能 import 它。
 */
const secretEnvKey = /token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credential/i;
const knownSecrets = new Set<string>();

/**
 * 登记 Dutydeck 自己持有的凭据值（服务进程和 Agent 配置里名字像凭据的环境变量）。
 * 这些值出现在任何经 redactTraceText 的文本里都按原值替换，不依赖格式，比如 Agent 把环境变量打印了出来。
 */
export function rememberSecretValues(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    const secret = typeof value === 'string' ? value.trim() : '';
    // 地址、路径和带空格的值不是凭据本身（如 *_TOKEN_URL），登记了只会误伤正常文本。
    if (secret.length >= 12 && secretEnvKey.test(key) && !/^(?:[a-z][a-z0-9+.-]*:\/\/|[/~.])|\s/i.test(secret)) knownSecrets.add(secret);
  }
}
rememberSecretValues(process.env);

/** 常见凭据的固定格式：没有 key=value 上下文也认得出，比如命令输出或日志片段里单独出现的 token。 */
const tokenFormats = [
  /\bsk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

const redactKnownSecrets = (value: string) => {
  let result = value;
  for (const secret of knownSecrets) if (result.includes(secret)) result = result.split(secret).join('[REDACTED]');
  return tokenFormats.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), result);
};

export const sensitiveTraceKey = /(?:authorization|api[_-]?key|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)$/i;
export const redactTraceText = (value: string) => redactKnownSecrets(value)
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
