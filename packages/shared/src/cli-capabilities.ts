import type { InsightClient } from './session-insight.js';

/**
 * Claude Code 家族终端适配器：claude-code 与它的两个 fork（seed / relay）。三者共用同一套适配器实现、
 * 转写方言、按项目目录存放的 JSONL 会话，以及 PermissionRequest / PreToolUse hook。各层都从这里判定。
 */
export const claudeFamilyCliAdapterIds: readonly string[] = ['claude-code', 'seed', 'relay'];

export const isClaudeFamilyCli = (adapterId: string) => claudeFamilyCliAdapterIds.includes(adapterId);

/**
 * 终端适配器 id → 原生转写方言（Session Insight 客户端）。适配器 id 指的是磁盘上的客户端，
 * 模型供应商不算；没有可读转写的适配器（grok / opencode / gemini…）返回 undefined。
 */
export function transcriptClientForAdapter(adapterId: string): InsightClient | undefined {
  if (isClaudeFamilyCli(adapterId)) return 'claude';
  return adapterId === 'codex' || adapterId === 'traex' ? adapterId : undefined;
}

/** 终端 Codex 的 profile 设置（读 config.toml 的 [profiles.*]）。ACP 路径没有 profile 字段，不提供。 */
export const supportsCodexProfiles = (agent: { id: string; protocol?: string }) =>
  agent.protocol === 'pty-cli' && ['codex', 'codex-cli'].includes(agent.id);

/** 终端模式下能原生复制会话（fork）的适配器；调用方另外核对会话确实是 pty-cli。 */
export const supportsNativeFork = (agent: { id: string; adapterId?: string }) =>
  ['claude-code', 'codex'].includes(agent.adapterId ?? agent.id);
