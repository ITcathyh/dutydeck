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

/**
 * TraeX 输入框随机占位词列表（共 11 条）。
 * 来源版本：
 *  - 0.207.1-alpha.12 (~/.local/share/traex/current)
 *  - 0.205.1-alpha.3 (~/.local/share/traex/releases/0.205.1-alpha.3-*)
 * 从 traex 二进制 TUI 随机占位词表提取。
 */
export const TRAEX_PLACEHOLDERS = [
  'Explain this codebase',
  'Summarize recent commits',
  'Implement {feature}',
  'Find and fix a bug in @filename',
  'Write tests for @filename',
  'Improve documentation in @filename',
  'Run /review on my current changes',
  'Use /skills to list available skills',
  'Check recently modified functions for compatibility',
  'How many files have been modified?',
  'Will this algorithm scale well?',
] as const;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TRAEX_PLACEHOLDERS_PATTERN = TRAEX_PLACEHOLDERS.map(escapeRegex).join('|');
const TRAEX_COMPOSER = new RegExp(
  `^[›❯]\\s*(?:Ask (?:Trae|TraeCode CLI)(?: to do anything)?|${TRAEX_PLACEHOLDERS_PATTERN})?$`,
  'i',
);

// Only complete footer rows count as initialized evidence, never prose substrings.
// TraeX 允许 `☢ Full Access (shift+tab to cycle) · ← for agents` 后缀；
// Codex 允许用空白隔开的 `⚠ N warning(s) · f2 to view`。
const TRAEX_ACCESS_FOOTER = /(?:\s+☢ Full Access \(shift\+tab to cycle\) · ← for agents)?/;
const CODEX_WARNING_FOOTER = /(?:\s+⚠ \d+ warnings? · f2 to view)?/;

const CONTEXT_FOOTER = new RegExp(
  '^(?:[^\\s·]+(?: [^\\s·]+)? · (?:(?:\\/|~|…)[^\\s·]* · )?)?' +
  'Context \\d+% (?:left|used)(?: · weekly \\d+% left)?' +
  '(?: · ⎇ [^\\s·]+)?' +
  '(?: · (?:\\/|~|…)[^\\s·]*)?' +
  TRAEX_ACCESS_FOOTER.source +
  CODEX_WARNING_FOOTER.source +
  '$|^(?:\\? for shortcuts\\s+)?\\d+% (?:context )?left$',
  'i',
);

const PATH_FOOTER = new RegExp(
  '^[^\\s·]+(?: [^\\s·]+)? · ' +
  '(?:⎇ [^\\s·]+ · )?' +
  '(?:\\/|~|…)[^\\s·]*' +
  '(?: · (?:Ready|\\[Session\\]))?' +
  TRAEX_ACCESS_FOOTER.source +
  CODEX_WARNING_FOOTER.source +
  '$',
);
const DECORATION = /^[╰╯│╭╮─\-\s+=]+$|^\?\s+for\s+shortcuts$/i;

// 信任页识别必须逐行锚定：同一屏里标题行（逐行锚定）和编号菜单行（›/❯ 开头的选项行）都出现，
// 才算真正的目录信任确认页；只出现其中一种都不算。
// 这样可以彻底避免未就绪画面（如 resume 期间）正文折行恰好出现 "Trust this folder?" 等标题文字时误判报错。
const CODEX_TRUST_HEADING = /^Trust this folder\?/i;
const TRAEX_TRUST_HEADING = /^Do you trust the contents of this directory\?/i;
const CODEX_TRUST_MENU = /^[›❯]\s*1\.\s*(?:Trust and continue|Yes, continue)\s*$/i;
const TRAEX_TRUST_MENU = /^[›❯]\s*1\.\s*Yes,\s*continue\s*$/i;
// hooks 审核页不属于目录信任页：其选项是「Review hooks / Trust all and continue」。
const HOOKS_REVIEW_LINE = /Review hooks/i;

export function isTrustPrompt(screen: string, cli: 'Codex' | 'TraeX'): boolean {
  const lines = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => HOOKS_REVIEW_LINE.test(line))) return false;
  const heading = cli === 'Codex' ? CODEX_TRUST_HEADING : TRAEX_TRUST_HEADING;
  const menu = cli === 'Codex' ? CODEX_TRUST_MENU : TRAEX_TRUST_MENU;
  const hasHeading = lines.some(line => heading.test(line));
  const hasMenu = lines.some(line => menu.test(line));
  return hasHeading && hasMenu;
}

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

export interface ScreenReadyOptions {
  busyPattern?: RegExp;
  cwd?: string;
  permissionMode?: string;
}

export async function pollScreenReady(
  backend: PtyLike,
  cli: 'Codex' | 'TraeX',
  optionsOrBusyPattern?: RegExp | ScreenReadyOptions,
): Promise<void> {
  if (!backend.readScreen) throw new Error(`${cli} startup readiness requires a terminal screen reader`);
  const options: ScreenReadyOptions = optionsOrBusyPattern instanceof RegExp
    ? { busyPattern: optionsOrBusyPattern }
    : (optionsOrBusyPattern ?? {});
  const { busyPattern, cwd, permissionMode } = options;
  const startedAt = Date.now();
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    const screen = backend.readScreen();
    // 先判就绪：已就绪（例如对话正文里恰好提到信任弹窗文字、或 daemon 重连回旧会话）
    // 直接返回，避免把正文里的 "Trust this folder?" 之类文字误当成当前信任页。
    if (isInputReady(screen, cli, busyPattern)) return;
    // 只有确实未就绪时，才识别当前是否停在目录信任页。
    if (permissionMode !== 'full-trust' && isTrustPrompt(screen, cli)) {
      const targetCwd = cwd || process.cwd();
      throw new Error(`${cli} 需要先信任工作目录 ${targetCwd}：请在终端中确认信任，或改用完全信任模式。`);
    }
    await delay(STARTUP_POLL_MS);
  }
  throw new Error(`${cli} 启动尚未就绪，请打开终端检查启动状态后再发送任务。`);
}
