import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AGENT_LOGIN_REQUIRED, type AgentConfig } from '@dutydeck/shared';
import { childEnvironment } from '@dutydeck/shared/child-environment';

/**
 * Agent 因为没登录或凭据失效暂时用不了。只记在进程内：重启后由状态检查或下一次真实请求重新判断。
 * reason / remedy 是给人看的一句话（「Claude Code 未登录」「在开发机执行 `claude /login`…」），at 是记下的时间。
 */
export interface AgentUnavailable { reason: string; remedy: string; at: string }
export type AgentLoginState = 'logged_in' | 'logged_out' | 'unknown';
/** 不调用模型的登录状态检查；这个 Agent 没有对应命令时返回 undefined，下一次真实请求就是检查。 */
export type AgentStatusCheck = (agent: AgentConfig) => Promise<AgentLoginState> | undefined;

/** Claude 转写里认出的登录、凭据类失败（pty-driver transcript/claude.ts 的 apiErrorHint）。 */
const claudeAuthCodes = new Set(['claude_api_authentication_failed', 'claude_api_oauth_org_not_allowed', 'claude_api_account_on_hold',
  'claude_api_verification_required', 'claude_api_cloud_credential_error']);

const claudeCli = (agent: AgentConfig) => basename(agent.command) === 'claude';
const codexCli = (agent: AgentConfig) => /^codex(?:-acp)?$/.test(basename(agent.command));

/** 给人看的原因和修法。PTY 的 Claude 带 --settings 时凭据在那个文件里。 */
export function agentLoginProblem(agent: AgentConfig, kind: 'login' | 'credential'): Omit<AgentUnavailable, 'at'> {
  const state = kind === 'login' ? '未登录' : '登录或凭据失效';
  if (claudeCli(agent) || agent.args.some(arg => /claude-acp\.m?js$/.test(arg))) {
    const settings = agent.args[agent.args.indexOf('--settings') + 1];
    const file = agent.args.includes('--settings') && settings && !settings.trimStart().startsWith('{') ? settings : '~/.claude/settings.json';
    return { reason: `Claude Code ${state}`, remedy: `在开发机执行 \`claude /login\`，或检查 ${file} 里的凭据` };
  }
  if (codexCli(agent)) return { reason: `Codex ${state}`, remedy: '在开发机执行 `codex login`' };
  return { reason: `${agent.name} ${state}`, remedy: '在开发机上重新登录这个 Agent，或检查它的凭据配置' };
}

/** 一轮的 error 事件或抛错是不是登录、凭据失败：是就返回类别，认不出返回 undefined。 */
export function agentAuthFailure(failure: { code?: unknown; detailCode?: unknown; message?: unknown }): 'login' | 'credential' | undefined {
  if (failure.code === AGENT_LOGIN_REQUIRED || /\bauthentication required\b|\bnot logged in\b/i.test(String(failure.message ?? ''))) return 'login';
  // Codex 经 ACP 报的终止错误：类别 access 是账号、鉴权问题。
  if (claudeAuthCodes.has(String(failure.code)) || failure.code === 'ACP_PROVIDER_TERMINAL_ERROR' && /^(?:access|auth)/i.test(String(failure.detailCode ?? ''))) return 'credential';
  return undefined;
}

/**
 * 内置状态检查：PTY 的 Claude 用 `claude [--settings 文件] auth status --json`，Codex 用 `codex login status`。
 * 两个命令都只读本地凭据、不调模型，已登录退出码 0、未登录 1；其余（超时、找不到命令）按说不准处理。
 */
export const defaultAgentStatusCheck: AgentStatusCheck = agent => {
  const settings = agent.args.indexOf('--settings');
  const [command, args] = claudeCli(agent)
    ? [agent.command, [...settings >= 0 && agent.args[settings + 1] ? ['--settings', agent.args[settings + 1]!] : [], 'auth', 'status', '--json']]
    : codexCli(agent)
      ? [existsSync(join(dirname(agent.command), 'codex')) ? join(dirname(agent.command), 'codex') : 'codex', ['login', 'status']]
      : [undefined, []];
  if (!command) return undefined;
  return new Promise(resolve => {
    execFile(command, args, { env: childEnvironment(process.env, agent.env, { stripClaude: true }), timeout: 15_000, ...agent.cwd ? { cwd: agent.cwd } : {} },
      error => resolve(!error ? 'logged_in' : (error as { code?: unknown }).code === 1 ? 'logged_out' : 'unknown'));
  });
};
