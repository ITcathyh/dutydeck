import { redactCredentialText } from '@dutydeck/shared';

/**
 * 执行记录、记忆和 Agent 主动发出的群消息共用的凭据脱敏规则：卡片渲染和群工具发送用 redactTraceText 抹掉凭据，
 * 会话记忆用它判断一段内容是否疑似含凭据（会被改写即算）。
 *
 * 这里只保存服务端已知凭据；纯匹配规则位于 shared，供浏览器权限提示共用。
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

export const sensitiveTraceKey = /(?:authorization|api[_-]?key|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd)$/i;
export const redactTraceText = (value: string, placeholder = '[REDACTED]') => {
  let text = value;
  for (const secret of knownSecrets) if (text.includes(secret)) text = text.split(secret).join(placeholder);
  return redactCredentialText(text, placeholder);
};
