import type { CliAdapter } from '../types.js';
import { createClaudeFamilyAdapter } from './claude-family.js';

/**
 * Seed 是 Claude Code 的 fork（Relay 的旧发行名）：flag、slash 命令、落盘会话
 * 布局与 Claude Code 逐字同构，只有二进制名、鉴权和数据根不同。数据根定位、
 * 鉴权路径、transcript 桥都是 botmux 的基建，精简契约里不存在，所以这里与
 * claude-code 共用同一实现，只换 id。
 */
export function createSeedAdapter(): CliAdapter {
  return createClaudeFamilyAdapter('seed');
}
