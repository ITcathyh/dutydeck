import type { CliAdapter } from '../types.js';
import { createClaudeFamilyAdapter } from './claude-family.js';

/**
 * Relay 是 Seed 的当前发行名，同为 Claude Code 的 fork：flag、slash 命令、落盘
 * 会话布局与 Claude Code 逐字同构，只有二进制名、鉴权（ByteCloud / SuperRelay）
 * 和数据根不同。数据根定位与鉴权路径不在精简契约内，
 * 所以这里与 claude-code 共用同一实现，只换 id。
 */
export function createRelayAdapter(): CliAdapter {
  return createClaudeFamilyAdapter('relay');
}
