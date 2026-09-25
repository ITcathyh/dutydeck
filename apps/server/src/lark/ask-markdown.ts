/**
 * 询问卡片问题正文的 Markdown 渲染。
 *
 * 问题来自 Agent，默认按纯文本转义（避免 `_`、`*` 等被飞书当成 Markdown 误渲染），
 * 但要保留其中「带文字标签的网页链接」`[文字](https://…)`，让读者能直接点开。
 * 仅放行 http/https 链接；图片、javascript:、file: 等一律按字面文本展示。
 */

/** 飞书 @ 提及是结构化标记，转义掉其 ID 里的下划线会让整张卡非法，需整段保留。 */
const ESCAPE_PATTERN = /<at\s+id=(?:"ou_[\w-]+"|'ou_[\w-]+'|ou_[\w-]+)\s*><\/at>|[*_~`[\]\\]/g;

function escapeMd(s: string): string {
  return s.replace(ESCAPE_PATTERN, token => (token.startsWith('<at') ? token : `\\${token}`));
}

/**
 * 等价 markdown-it parseLinkDestination 的最小实现：从 `<` 包裹或裸 destination
 * 的起点开始解析，支持反斜杠转义与配对圆括号，返回解码后的 URL 与结束位置。
 */
function parseLinkDestination(s: string, start: number): { str: string; pos: number } | undefined {
  let pos = start;
  let raw = '';
  if (s[pos] === '<') {
    pos += 1;
    while (pos < s.length) {
      const ch = s[pos]!;
      if (ch === '\\' && pos + 1 < s.length) { raw += s[pos + 1]; pos += 2; continue; }
      if (ch === '>') return { str: raw, pos: pos + 1 };
      if (/\s/.test(ch)) return undefined;
      raw += ch;
      pos += 1;
    }
    return undefined;
  }
  let depth = 0;
  while (pos < s.length) {
    const ch = s[pos]!;
    if (/\s/.test(ch)) return undefined;
    if (ch === '\\' && pos + 1 < s.length) { raw += s[pos + 1]; pos += 2; continue; }
    if (ch === '(') { depth += 1; raw += ch; pos += 1; continue; }
    if (ch === ')') {
      if (depth === 0) return { str: raw, pos };
      depth -= 1;
      raw += ch;
      pos += 1;
      continue;
    }
    raw += ch;
    pos += 1;
  }
  return undefined;
}

const LINK_OPEN = /\[([^\]\r\n]+)\]\(/g;

/** 保留可识别的 http/https 网页链接，其余 Markdown 特殊字符转义为字面文本。 */
export function renderQuestionMarkdown(s: string): string {
  let cursor = 0;
  let rendered = '';
  for (const match of s.matchAll(LINK_OPEN)) {
    const start = match.index!;
    if (start < cursor || s[start - 1] === '!') continue;
    // 奇数个前导反斜杠 = 被转义的 `[`，按字面处理。
    const backslashes = s.slice(0, start).match(/\\+$/)?.[0].length ?? 0;
    if (backslashes % 2 === 1) continue;
    const destination = parseLinkDestination(s, start + match[0].length);
    if (!destination || s[destination.pos] !== ')') continue;
    let url: URL;
    try { url = new URL(destination.str); }
    catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    // 圆括号是合法 URL 字符，但裸括号会提前终结 Markdown 链接，统一编码。
    const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
    rendered += escapeMd(s.slice(cursor, start)) + `[${escapeMd(match[1]!)}](${href})`;
    cursor = destination.pos + 1;
  }
  return rendered + escapeMd(s.slice(cursor));
}
