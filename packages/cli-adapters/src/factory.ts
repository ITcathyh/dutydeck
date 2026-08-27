import type { CliAdapter } from './types.js';
import { createClaudeCodeAdapter } from './adapters/claude-code.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createOpenCodeAdapter } from './adapters/opencode.js';
import { createGrokAdapter } from './adapters/grok.js';
import { createCursorAdapter } from './adapters/cursor.js';
import { createKimiAdapter } from './adapters/kimi.js';
import { createTraexAdapter } from './adapters/traex.js';

export const ALL_CLI_IDS = [
  'claude-code',
  'codex',
  'gemini',
  'opencode',
  'grok',
  'cursor',
  'kimi',
  'traex',
] as const;

const factories = {
  'claude-code': createClaudeCodeAdapter,
  codex: createCodexAdapter,
  gemini: createGeminiAdapter,
  opencode: createOpenCodeAdapter,
  grok: createGrokAdapter,
  cursor: createCursorAdapter,
  kimi: createKimiAdapter,
  traex: createTraexAdapter,
} satisfies Record<(typeof ALL_CLI_IDS)[number], () => CliAdapter>;

/** 按 id 创建适配器；未知 id 抛 Error。 */
export function createCliAdapter(id: string): CliAdapter {
  const factory = (factories as Record<string, () => CliAdapter>)[id];
  if (!factory) throw new Error(`Unknown CLI adapter: ${id}`);
  return factory();
}

/** 按 id 获取适配器；未知 id 返回 undefined。 */
export function getCliAdapter(id: string): CliAdapter | undefined {
  return (factories as Record<string, () => CliAdapter>)[id]?.();
}
