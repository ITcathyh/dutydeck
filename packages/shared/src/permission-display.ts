/** Redact before truncating so a clipped credential cannot escape the matching rule. */
export function permissionDisplayText(value: unknown, secrets: string[] = [], limit = 1200): string {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:authorization|cookie|set-cookie)["']?\s*:\s*)[^\r\n"']+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+\/=-]+/gi, '$1 [REDACTED]')
    .replace(/(--turn(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&]+)/g, '$1[REDACTED]')
    .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)[\w-]*)["']?\s*(?:[:=]\s*|\s+))(?:("[^"\n]*"|'[^'\n]*')|[^\s;&]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,})\b/gi, '[REDACTED]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
