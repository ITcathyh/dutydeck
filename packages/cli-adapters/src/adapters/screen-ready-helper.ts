import type { PtyLike } from '../types.js';

const STARTUP_POLL_MS = 100;
const STARTUP_TIMEOUT_MS = 30_000;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const LOADING = /^│\s*(?:model|directory):\s*loading\b/i;
const LOADED_BANNER = /^│[ \t]+model:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│[ \t]*\n│[ \t]+directory:[ \t]+(?!loading\b)[^│\s][^│\r\n]*│$/im;
const PENDING = /^(?:Resuming(?: session)?(?:…|\.{3})?|(?:[•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*)?Working[^\r\n]{0,160}esc to interrupt\)?|esc to interrupt|Queued for capacity|Too many requests right now(?:\. You're in the queue.*)?|Select permissions|Review hooks|Press enter to continue)$/i;
const CODEX_BANNER = /^(?:Codex|│\s*>_ OpenAI Codex \(v[^\s()]+\)\s*│)$/i;
const TRAEX_BANNER = /^(?:TraeX|TraeCode CLI)$/i;
const CODEX_COMPOSER = /^[›❯]\s*(?:Ask Codex(?: to do anything)?)?$/i;
const TRAEX_COMPOSER = /^[›❯]\s*(?:Ask (?:Trae|TraeCode CLI)(?: to do anything)?|Find and fix a bug in @filename)?$/i;

// Only complete footer rows count as initialized evidence, never prose substrings.
const CONTEXT_FOOTER = /^(?:[^\s·]+(?: [^\s·]+)? · (?:(?:\/|~)[^\s·]* · )?)?Context \d+% (?:left|used)(?: · weekly \d+% left)?(?: · (?:\/|~)[^\s·]*)?$|^(?:\? for shortcuts\s+)?\d+% (?:context )?left$/i;
const PATH_FOOTER = /^[^\s·]+(?: [^\s·]+)? · (?:\/|~)[^\s·]*(?: · (?:Ready|\[Session\]))?$/;
const DECORATION = /^[╰╯│╭╮─\-\s+=]+$|^\?\s+for\s+shortcuts$/i;

function isInitializedFooter(line: string): boolean {
  return CONTEXT_FOOTER.test(line) || PATH_FOOTER.test(line);
}

/** readScreen is a rendered viewport, not a raw PTY transcript. */
export function isInputReady(screen: string, cli: 'Codex' | 'TraeX', busyPattern?: RegExp): boolean {
  const lines = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.some(line => LOADING.test(line) || PENDING.test(line)
    || /^[›❯]\s*\d+\./.test(line) || busyPattern?.test(line))) return false;

  let prompt = lines.length - 1;
  while (prompt >= 0 && !/^[›❯](?:\s|$)/.test(lines[prompt]!)) prompt--;
  if (prompt < 0 || !(cli === 'Codex' ? CODEX_COMPOSER : TRAEX_COMPOSER).test(lines[prompt]!)) return false;
  const footer = lines.slice(prompt + 1);
  if (footer.some(line => !isInitializedFooter(line) && !DECORATION.test(line))) return false;
  const banner = lines.slice(0, prompt);
  return footer.some(isInitializedFooter) || LOADED_BANNER.test(banner.join('\n'))
    || banner.some(line => (cli === 'Codex' ? CODEX_BANNER : TRAEX_BANNER).test(line));
}

export async function pollScreenReady(
  backend: PtyLike,
  cli: 'Codex' | 'TraeX',
  busyPattern?: RegExp,
): Promise<void> {
  if (!backend.readScreen) throw new Error(`${cli} startup readiness requires a terminal screen reader`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (isInputReady(backend.readScreen(), cli, busyPattern)) return;
    await delay(STARTUP_POLL_MS);
  }
  throw new Error(`${cli} 启动尚未就绪，请打开终端检查启动状态后再发送任务。`);
}
