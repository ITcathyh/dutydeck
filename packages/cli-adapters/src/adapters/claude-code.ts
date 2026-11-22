import type { CliProfile } from '../profile.js';
import { claudeDataDir } from '../cli-paths.js';
import type { CliAdapter } from '../types.js';
import { createClaudeFamilyAdapter } from './claude-family.js';

/**
 * Claude Code 适配器。参数形态、输入时序与 idle pattern 由 claude-family 共用
 * 实现提供——seed / relay 是同一个 fork 血统，三者在精简契约下只有 id 不同。
 */
export { CLAUDE_INPUT_CHUNK_BYTES, chunkTextByUtf8Bytes } from './claude-family.js';

export function createClaudeCodeAdapter(): CliAdapter {
  return createClaudeFamilyAdapter('claude-code');
}

export const claudeCodeProfile = {
  createAdapter: createClaudeCodeAdapter,
  discoveryOrder: 0,
  contributions: [
    { id: 'claude', name: 'Claude Code', command: 'claude', adapterId: 'claude-code', capabilities: { pause: false, resume: true } },
    { id: 'claude-code', name: 'Claude', command: 'claude', adapterId: 'claude-code', capabilities: { pause: false, resume: true } },
  ],
  nativeOrder: 0,
  sessionId: (context, readers) => readers.claude.resolve(context),
  transcript: (options, readers) => new readers.claude(options),
  dataRoot: claudeDataDir,
  insightClient: 'claude',
  automaticResume: true,
} satisfies CliProfile;
