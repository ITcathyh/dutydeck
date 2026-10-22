/** Pure credential rules shared by permission prompts, traces and diagnostics. */
const tokenFormats = [
  /\bsk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:ant-api\d{2}-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
];

export function redactCredentialText(value: string, placeholder = '[REDACTED]', privateKeyPlaceholder = '[REDACTED_PRIVATE_KEY]'): string {
  let text = value
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)/g, () => privateKeyPlaceholder)
    // Userinfo ends at the last @ in the authority, including passwords with @.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, (_match, scheme: string) => `${scheme}${placeholder}@`)
    // Consume JSON string escapes and JSON-escaped command quotes before matching bare assignments.
    .replace(/(\b(?:authorization|[A-Za-z0-9_]*(?:api[_-]?key|secret[_-]?key|access[_-]?key|access[_-]?token|token|secret|password|passwd|pwd))(?:\\?["'])?\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|\\"(?:(?!\\")[\s\S])*\\")/gi,
      (_match, prefix: string, quoted: string) => {
        const quote = quoted.startsWith('\\') ? '\\"' : '"';
        return prefix + quote + placeholder + quote;
      })
    .replace(/(\bauthorization\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n"',;&}]+)/gi, (_match, prefix: string) => prefix + placeholder)
    .replace(/(\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n"'}]+)/gi, (_match, prefix: string) => prefix + placeholder)
    .replace(/\b(Bearer|Basic)\s+[^"'\s,;}&]+/gi, (_match, scheme: string) => `${scheme} ${placeholder}`)
    .replace(/(--turn(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&]+)/g, (_match, prefix: string) => prefix + placeholder)
    .replace(/(^|[^A-Za-z0-9_-])((?:--?)(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)\s+)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gim,
      (_match, before: string, prefix: string) => before + prefix + placeholder)
    .replace(/((?:\b(?:api[_-]?key|access[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd)|\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|API_KEY)[A-Z0-9_]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      (_match, prefix: string) => prefix + placeholder)
    .replace(/(?<=[?&](?:token|api[_-]?key|access[_-]?key|access[_-]?token|auth(?:[_-]?token)?|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|key|sig|signature|private[_-]?key)=)[^&\s"'#]+/gi, () => placeholder);
  for (const pattern of tokenFormats) text = text.replace(pattern, () => placeholder);
  return text;
}
