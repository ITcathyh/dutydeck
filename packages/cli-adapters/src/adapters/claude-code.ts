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
