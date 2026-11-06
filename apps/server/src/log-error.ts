import { redactCredentialText } from '@dutydeck/shared';

/**
 * 日志里 `{ error }` 字段的序列化。
 *
 * pino 只对 `err` 键做 Error 序列化，仓库里的写法是 `log.warn({ error }, ...)`，Error 的 message / stack
 * 不可枚举，JSON 化后只剩 `{}`。这里只挑排障需要的字段，不照搬整个对象：axios / SDK 错误身上挂着
 * 请求配置（含 Authorization 头）和完整响应体，原样打出去会把密钥和正文写进日志。message 与 stack
 * 也经凭据脱敏并截断。
 */
const MAX_MESSAGE = 500;
const MAX_STACK = 2_000;
const MAX_DEPTH = 3;
const MAX_AGGREGATE = 5;

type ErrorLike = Error & {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  details?: { upstreamCode?: unknown; upstreamHttpStatus?: unknown };
  response?: { status?: unknown };
  errors?: unknown;
};

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}…` : text;
const scalar = (value: unknown) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;

function serialize(value: unknown, depth: number): unknown {
  if (!(value instanceof Error)) return value;
  const error = value as ErrorLike;
  const fields: Record<string, unknown> = {
    type: error.name,
    message: clip(redactCredentialText(String(error.message ?? '')), MAX_MESSAGE),
    ...(typeof error.stack === 'string' ? { stack: clip(redactCredentialText(error.stack), MAX_STACK) } : {})
  };
  const extra: Record<string, unknown> = {
    code: scalar(error.code),
    status: scalar(error.status) ?? scalar(error.response?.status),
    statusCode: scalar(error.statusCode),
    upstreamCode: scalar(error.details?.upstreamCode),
    upstreamHttpStatus: scalar(error.details?.upstreamHttpStatus)
  };
  for (const [key, field] of Object.entries(extra)) if (field !== undefined) fields[key] = field;
  if (depth < MAX_DEPTH && error.cause !== undefined) fields.cause = serialize(error.cause, depth + 1);
  if (depth < MAX_DEPTH && Array.isArray(error.errors)) fields.errors = error.errors.slice(0, MAX_AGGREGATE).map(item => serialize(item, depth + 1));
  return fields;
}

/** 非 Error 值（字符串、普通对象）原样返回，不影响传字符串的调用点。 */
export function serializeLogError(value: unknown): unknown {
  return serialize(value, 0);
}
