import { remoteApprovalCliAdapterIds, type AgentConfig } from '@dutydeck/shared';

/**
 * 先出计划：第一轮只调研、出计划（任务以 deny-all 运行，写操作被拦），用户批准后在同一会话按原权限执行。
 *
 * 计划轮的请求原文固定以 `/plan ` 开头，重试、重投和重启恢复都带着它，所以任何路径重跑都仍是计划轮。
 */
const planPattern = /^\/plan(?:\s+([\s\S]*))?$/;

/** 请求原文是计划轮时返回要计划的任务（可能为空串）；不是返回 undefined。 */
export function planTaskOf(prompt: string): string | undefined {
  const match = planPattern.exec(prompt.trim());
  return match ? (match[1] ?? '').trim() : undefined;
}

export const planPrompt = (task: string) => `/plan ${task}`;

/** 批准后那一轮的请求原文：计划已在同一会话的上文里。 */
export const planApprovedPrompt = '计划已批准，请按你上面给出的最新计划开始执行。执行中如果发现计划需要调整，先说明原因再继续。';

/** 提修改意见后重新出计划的请求原文；仍以 /plan 开头，所以还是计划轮。 */
export const planRevisePrompt = (feedback: string) => planPrompt(`按修改意见重出计划：${feedback.trim()}`);

/** 计划轮交给 Agent 的系统要求，放在材料前面。 */
export const planInstructionBlock = [
  '[Dutydeck 先出计划 · 系统要求]',
  '这一轮只调研并给出执行计划，不要修改任何文件，也不要执行会产生副作用的命令；Dutydeck 会拦下写文件、改仓库和运行程序的操作。可以读文件、搜索、运行只读命令。',
  '最后的回复就是计划本身，写清：要达成什么、逐步要改哪些文件或做哪些操作、有什么风险和怎么回退、做完怎么验证。用户批准后，你会在同一会话里按计划执行。',
  '[/Dutydeck 先出计划]'
].join('\n');

export const planAgentPrompt = (material: string) => `${planInstructionBlock}\n\n${material}`;

/** 计划卡和 Web 计划操作的有效期：与审批卡同一个 24 小时上限。 */
export const planDecisionWindowMs = 24 * 60 * 60_000;

/** Claude ACP：内置 claude，或启动命令 / 入口是 claude-agent-acp 一类。codex-acp 等在沙箱里写文件不问，拦不住。 */
const isClaudeAcp = (agent: Pick<AgentConfig, 'id' | 'command' | 'args' | 'adapterId'>) =>
  agent.id === 'claude' || /^claude/i.test(agent.adapterId ?? '')
  || /^claude/i.test(agent.command.split(/[\\/]/).pop() ?? '')
  || agent.args.some(arg => /claude-(?:agent-|code-)?acp/i.test(arg));

/**
 * 这个会话能不能先出计划。能保证计划阶段不改文件的只有两种：Claude 家族终端（PreToolUse 守卫）和 Claude ACP
 * （deny-all 拒绝一切需要确认的工具调用）。不能时返回给用户看的原因，调用方必须拒绝，不能退回直接执行。
 */
export function planUnsupportedReason(session: { protocol?: string }, agent: Pick<AgentConfig, 'id' | 'name' | 'command' | 'args' | 'adapterId'> | undefined): string | undefined {
  const supported = agent && (session.protocol === 'pty-cli' ? remoteApprovalCliAdapterIds.includes(agent.adapterId ?? agent.id)
    : session.protocol === 'acp' && isClaudeAcp(agent));
  if (supported) return undefined;
  return `当前 Agent（${agent?.name ?? '未知'}）不支持先出计划：只有 Claude Code（终端模式或 ACP）能保证计划阶段不改文件。请直接下达任务，或换用 Claude Code 的会话。`;
}
