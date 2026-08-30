import type { CliAdapter } from './types.js';
import { createClaudeCodeAdapter } from './adapters/claude-code.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createOpenCodeAdapter } from './adapters/opencode.js';
import { createGrokAdapter } from './adapters/grok.js';
import { createCursorAdapter } from './adapters/cursor.js';
import { createKimiAdapter } from './adapters/kimi.js';
import { createTraexAdapter } from './adapters/traex.js';
import { createAntigravityAdapter } from './adapters/antigravity.js';
import { createCocoAdapter } from './adapters/coco.js';
import { createOpenCode2Adapter } from './adapters/opencode2.js';
import { createMtrAdapter } from './adapters/mtr.js';
import { createHermesAdapter } from './adapters/hermes.js';
import { createMiraAdapter } from './adapters/mira.js';
import { createMirAdapter } from './adapters/mir.js';
import { createPiAdapter } from './adapters/pi.js';
import { createOhMyPiAdapter } from './adapters/oh-my-pi.js';
import { createCopilotAdapter } from './adapters/copilot.js';
import { createKiroCliAdapter } from './adapters/kiro-cli.js';
import { createRiffAdapter } from './adapters/riff.js';
import { createReasonixAdapter } from './adapters/reasonix.js';
import { createDshAdapter } from './adapters/dsh.js';
import { createDshTuiAdapter } from './adapters/dsh-tui.js';
import { createMojoAdapter } from './adapters/mojo.js';
import { createSeedAdapter } from './adapters/seed.js';
import { createRelayAdapter } from './adapters/relay.js';
import { createAidenAdapter } from './adapters/aiden.js';
import { createGeniusAdapter } from './adapters/genius.js';
import { createCodexAppAdapter } from './adapters/codex-app.js';

/**
 * 已知 CLI id 全集。**从 `factories` 的键派生**，而不是手写第二份清单：
 * botmux 的同名常量曾因手写副本两次静默漏项（少了 reasonix / mojo）——
 * 一个 `CliId[]` 字面量只会检查「有没有多余成员」，从不检查「有没有漏」。
 */
const factories = {
  'claude-code': createClaudeCodeAdapter,
  codex: createCodexAdapter,
  gemini: createGeminiAdapter,
  opencode: createOpenCodeAdapter,
  grok: createGrokAdapter,
  cursor: createCursorAdapter,
  kimi: createKimiAdapter,
  traex: createTraexAdapter,
  antigravity: createAntigravityAdapter,
  coco: createCocoAdapter,
  opencode2: createOpenCode2Adapter,
  mtr: createMtrAdapter,
  hermes: createHermesAdapter,
  mira: createMiraAdapter,
  mir: createMirAdapter,
  pi: createPiAdapter,
  'oh-my-pi': createOhMyPiAdapter,
  copilot: createCopilotAdapter,
  'kiro-cli': createKiroCliAdapter,
  riff: createRiffAdapter,
  reasonix: createReasonixAdapter,
  dsh: createDshAdapter,
  'dsh-tui': createDshTuiAdapter,
  mojo: createMojoAdapter,
  seed: createSeedAdapter,
  relay: createRelayAdapter,
  aiden: createAidenAdapter,
  genius: createGeniusAdapter,
  'codex-app': createCodexAppAdapter,
} satisfies Record<string, () => CliAdapter>;

export type CliId = keyof typeof factories;

export const ALL_CLI_IDS = Object.keys(factories) as readonly CliId[];

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
