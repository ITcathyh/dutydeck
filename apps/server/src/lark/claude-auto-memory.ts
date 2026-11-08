import { basename } from 'node:path';
import type { AgentConfig, Session, StoredLarkConfig } from '@dutydeck/shared';
import { larkAgentSessionBinding } from './agent-tools.js';
import { larkMemoryEnabled } from './config.js';

/**
 * 会话内部环境键：值为 'off' 时，终端驱动（Claude 家族适配器）和内置 claude-acp.mjs 给 Claude 子进程补上
 * CLAUDE_CODE_DISABLE_AUTO_MEMORY=1，放在用户显式值之下。小写 snake_case 才能进 ACPX 持久化 env；
 * 不属于 scoped reset 键，变化时不重建已有 ACP 会话。
 */
export const claudeAutoMemoryEnvKey = 'dutydeck_claude_auto_memory';

/** 内置 ACP Claude 经 Dutydeck 的 claude-acp.mjs 启动；自定义 ACP Claude 不读这个键。 */
const launchesBuiltinClaudeAcp = (agent: Pick<AgentConfig, 'command' | 'args'>) =>
  [agent.command, ...(agent.args ?? [])].some(part => typeof part === 'string' && basename(part) === 'claude-acp.mjs');

/**
 * 机器人设了 claudeAutoMemory=off、开着会话记忆，且这是它的飞书群聊会话时，给 Agent env 加上标记。
 * 终端会话由驱动按适配器再判是否 Claude 家族；ACP 只给内置 claude-acp.mjs 加。
 * 私聊、Web、定时、工作项和委托子会话不是飞书群聊绑定，一律不加。
 */
export async function withClaudeAutoMemoryMarker(
  agent: AgentConfig,
  session: Pick<Session, 'id' | 'source' | 'sourceId' | 'protocol'>,
  readBot: (appId: string) => Promise<Pick<StoredLarkConfig, 'claudeAutoMemory' | 'memoryEnabled' | 'defaultGroupParticipation'> | undefined>
): Promise<AgentConfig> {
  // 开关只有机器人设置这一个：Agent env 里手写的同名键不算数。
  const { [claudeAutoMemoryEnvKey]: _ignored, ...env } = agent.env ?? {};
  const unmarked = _ignored === undefined ? agent : { ...agent, env };
  const binding = larkAgentSessionBinding(session);
  if (binding?.chatType !== 'group') return unmarked;
  const protocol = session.protocol ?? agent.protocol;
  if (protocol !== 'pty-cli' && !(protocol === 'acp' && launchesBuiltinClaudeAcp(agent))) return unmarked;
  const bot = await readBot(binding.appId);
  if (bot?.claudeAutoMemory !== 'off' || !larkMemoryEnabled(bot)) return unmarked;
  return { ...agent, env: { ...env, [claudeAutoMemoryEnvKey]: 'off' } };
}
