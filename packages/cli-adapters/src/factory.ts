import type { CliProfile } from './profile.js';
import type { CliAdapter } from './types.js';
import { claudeCodeProfile } from './adapters/claude-code.js';
import { codexProfile } from './adapters/codex.js';
import { geminiProfile } from './adapters/gemini.js';
import { openCodeProfile } from './adapters/opencode.js';
import { grokProfile } from './adapters/grok.js';
import { cursorProfile } from './adapters/cursor.js';
import { kimiProfile } from './adapters/kimi.js';
import { traexProfile } from './adapters/traex.js';
import { antigravityProfile } from './adapters/antigravity.js';
import { cocoProfile } from './adapters/coco.js';
import { openCode2Profile } from './adapters/opencode2.js';
import { mtrProfile } from './adapters/mtr.js';
import { hermesProfile } from './adapters/hermes.js';
import { miraProfile } from './adapters/mira.js';
import { mirProfile } from './adapters/mir.js';
import { piProfile } from './adapters/pi.js';
import { ohMyPiProfile } from './adapters/oh-my-pi.js';
import { copilotProfile } from './adapters/copilot.js';
import { kiroCliProfile } from './adapters/kiro-cli.js';
import { riffProfile } from './adapters/riff.js';
import { reasonixProfile } from './adapters/reasonix.js';
import { dshProfile } from './adapters/dsh.js';
import { dshTuiProfile } from './adapters/dsh-tui.js';
import { mojoProfile } from './adapters/mojo.js';
import { seedProfile } from './adapters/seed.js';
import { relayProfile } from './adapters/relay.js';
import { aidenProfile } from './adapters/aiden.js';
import { geniusProfile } from './adapters/genius.js';
import { codexAppProfile } from './adapters/codex-app.js';
import { codemProfile } from './adapters/codem.js';

/**
 * 已知 CLI id 全集。**从 `profiles` 的键派生**，而不是手写第二份清单：
 * 避免手写副本可能漏项——
 * 一个 `CliId[]` 字面量只会检查「有没有多余成员」，从不检查「有没有漏」。
 */
const profiles = {
  'claude-code': claudeCodeProfile,
  codex: codexProfile,
  gemini: geminiProfile,
  opencode: openCodeProfile,
  grok: grokProfile,
  cursor: cursorProfile,
  kimi: kimiProfile,
  traex: traexProfile,
  antigravity: antigravityProfile,
  coco: cocoProfile,
  opencode2: openCode2Profile,
  mtr: mtrProfile,
  hermes: hermesProfile,
  mira: miraProfile,
  mir: mirProfile,
  pi: piProfile,
  'oh-my-pi': ohMyPiProfile,
  copilot: copilotProfile,
  'kiro-cli': kiroCliProfile,
  riff: riffProfile,
  reasonix: reasonixProfile,
  dsh: dshProfile,
  'dsh-tui': dshTuiProfile,
  mojo: mojoProfile,
  seed: seedProfile,
  relay: relayProfile,
  aiden: aidenProfile,
  genius: geniusProfile,
  'codex-app': codexAppProfile,
  codem: codemProfile,
} satisfies Record<string, CliProfile>;

export type CliId = keyof typeof profiles;

export const ALL_CLI_IDS = Object.keys(profiles) as readonly CliId[];

export function getCliProfile(id: string): CliProfile | undefined {
  return Object.hasOwn(profiles, id) ? profiles[id as CliId] : undefined;
}

export const nativeProfiles = ALL_CLI_IDS.filter(id => getCliProfile(id)?.transcript || getCliProfile(id)?.sessionId)
  .sort((a, b) => (getCliProfile(a)?.nativeOrder ?? Infinity) - (getCliProfile(b)?.nativeOrder ?? Infinity));

export const PTY_AGENT_CONTRIBUTIONS = (Object.values(profiles) as CliProfile[])
  .filter(profile => profile.contributions)
  .sort((a, b) => (a.discoveryOrder ?? Infinity) - (b.discoveryOrder ?? Infinity))
  .flatMap(profile => profile.contributions!);

export function createCliAdapter(id: string): CliAdapter {
  const profile = getCliProfile(id);
  if (!profile) throw new Error(`Unknown CLI adapter: ${id}`);
  return profile.createAdapter();
}

export function getCliAdapter(id: string): CliAdapter | undefined {
  return getCliProfile(id)?.createAdapter();
}
