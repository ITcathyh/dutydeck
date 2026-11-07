import type { PermissionMode } from './index.js';

export const agentCommandApprovalReason = '因 dutydeck agent 命令自动放行';

/** A deliberately small shell lexer: no expansions, operators, escapes or multiline input. */
function simpleShellWords(command: string): boolean {
  if (/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(command)) return false;
  let quote: "'" | '"' | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && /[$`\\]/.test(char)) return false;
    } else if (char === "'" || char === '"') quote = char;
    else if (/[;&|<>()$`\\*?\[{~#]/.test(char)) return false;
  }
  return !quote;
}

/** Words after quote removal; only valid for input that already passed simpleShellWords. */
function unquotedWords(command: string): string[] {
  const words: string[] = [];
  let quote: "'" | '"' | undefined;
  let word: string | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; word ??= ''; }
    else if (char === ' ' || char === '\t') { if (word !== undefined) words.push(word); word = undefined; }
    else word = (word ?? '') + char;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** These upload local file bytes to the chat unredacted, so they always get a human approval. */
const approvalRequiredWords = new Set(['send-file']);

/** Only session-injected capabilities count; never consult the host process environment. */
export function isAgentCommandAutoApproval(input: {
  permissionMode?: PermissionMode;
  kind?: string;
  command?: unknown;
  env?: Record<string, string | undefined>;
}): boolean {
  const { permissionMode, kind, command, env } = input;
  if ((permissionMode !== 'ask' && permissionMode !== 'approve-reads') || kind !== 'execute'
    || typeof command !== 'string' || !env?.dutydeck_group_tools_token?.trim()
    || !env.dutydeck_group_tools_url?.trim()) return false;
  const prefix = env.dutydeck_group_tools_command;
  if (!prefix || prefix !== prefix.trim() || !simpleShellWords(prefix)) return false;
  // Check before trim so even a leading/trailing newline fails closed.
  if (!simpleShellWords(command)) return false;
  const text = command.trim();
  if (!text.startsWith(prefix)) return false;
  const rest = text.slice(prefix.length);
  return /^[ \t]+agent[ \t]+\S/.test(rest) && !unquotedWords(rest).some(word => approvalRequiredWords.has(word));
}
