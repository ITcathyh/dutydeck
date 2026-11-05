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

/** 卡片与 Web 自由文本输入框的上限：飞书 input 的 max_length、Web 输入框的 maxLength 都用这个值。 */
export const freeTextInputMaxLength = 1000;
/**
 * 自由文本的绝对字节上限（UTF-8），挡住绕过输入框伪造的超大回调。
 * 最长的标准 emoji 字素约 35 字节（如带肤色的亲吻组合），1000 个仍在 64 KB 内。
 */
export const freeTextInputMaxBytes = 64 * 1024;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const utf8 = new TextEncoder();

/**
 * 服务端校验自由文本长度。飞书文档没写 input 的 max_length 按什么计数，浏览器 maxLength 按 UTF-16 码元计；
 * 按字素（用户看到的一个字符，如组合 emoji）计数是几种口径里最宽的，输入框放行的文字服务端一定不拒。
 * 字素数不限制字节，另按 UTF-8 字节封顶；先查字节，超大文本不做分段。
 */
export function freeTextInputViolation(text: string, maxLength = freeTextInputMaxLength): 'bytes' | 'length' | undefined {
  // UTF-8 字节数不少于 UTF-16 码元数，码元超限时不必编码。
  if (text.length > freeTextInputMaxBytes || utf8.encode(text).length > freeTextInputMaxBytes) return 'bytes';
  let length = 0;
  for (const _ of graphemeSegmenter.segment(text)) if (++length > maxLength) return 'length';
  return undefined;
}

/** 用户拒绝审批时附带说明的长度上限（去控制字符、去首尾空白之后按字素计），与输入框一致。 */
export const permissionRejectReasonMaxLength = freeTextInputMaxLength;

/** 「拒绝并说明」输入框提示；Web 审批卡、收件箱和飞书审批卡共用。ACP 驱动回执只有 reject_once，原因送不到 Agent。 */
export const permissionRejectReasonHint = '原因会记录在审批历史；终端模式的 Agent 会收到原因，ACP 模式的 Agent 只知道被拒绝。';

/** 去掉控制字符（保留换行与制表符）和首尾空白；空串返回 undefined，表示没有说明。 */
export function cleanPermissionRejectReason(value: string): string | undefined {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim() || undefined;
}
