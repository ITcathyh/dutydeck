import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCliAdapter } from '@dutydeck/cli-adapters';
import { resolveCliSessionId } from '@dutydeck/pty-driver';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import type { AgentConfig, Session } from '@dutydeck/shared';

/** Only a durable marker can identify the source. Never choose the CLI's latest session. */
export function larkNativeSessionId(session: Session, agent: Pick<AgentConfig, 'id'> & Partial<AgentConfig>): string | undefined {
  if (session.protocol !== 'pty-cli') return undefined;
  return resolveCliSessionId(agent.adapterId ?? agent.id, { sessionId: session.id, cwd: session.cwd,
    env: childEnvironment(process.env, agent.env ?? {}, { stripClaude: true }), requireMarker: true });
}

export function larkResumeUnavailable(session: Session, agent: (Pick<AgentConfig, 'id'> & Partial<AgentConfig>) | undefined): string | undefined {
  const hint = '可以用 /new --handoff 把最近结果和 git 状态交接给新会话。';
  if (!agent?.capabilities?.resume) return `Agent ${session.agentId} 不支持恢复会话。${hint}`;
  if (session.protocol === 'acp') return undefined;
  const adapter = getCliAdapter(agent.adapterId ?? agent.id);
  if (session.protocol !== 'pty-cli' || !adapter?.capabilities.resume || !adapter.buildResumeCommand) return `Agent ${session.agentId} 不支持原生恢复。${hint}`;
  const nativeId = larkNativeSessionId(session, agent);
  if (!nativeId || !adapter.buildResumeCommand(nativeId)) return `找不到 ${session.agentId} 这条会话可核实的原生上下文，不能恢复为空会话。${hint}`;
  return undefined;
}

export function larkNativeForkId(session: Session, agent: Pick<AgentConfig, 'id'> & Partial<AgentConfig>, targetAgentId: string): string | undefined {
  if (targetAgentId !== session.agentId || session.protocol !== 'pty-cli' || !['claude-code', 'codex'].includes(agent.adapterId ?? agent.id)) return undefined;
  return larkNativeSessionId(session, agent);
}

/** Distinguish a real (including unborn) git worktree from an unrelated .git directory.
 * Unknown git failures must not silently opt two Agents into a shared directory. */
export async function larkForkWorkspaceMode(cwd: string, requested?: 'shared' | 'worktree'): Promise<'shared' | 'worktree'> {
  if (requested) return requested;
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000 });
    if (stdout.trim() === 'true') return 'worktree';
    throw new Error('该目录不是可创建 worktree 的 git 工作目录。');
  } catch (error) {
    if ((error as { code?: number }).code === 128 && /not a git repository/i.test(String((error as { stderr?: string }).stderr))) return 'shared';
    throw new Error('无法确认分身目录的 git 状态，未使用共享目录。请检查目录，或明确指定 --workspace shared。');
  }
}
