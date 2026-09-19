import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { getCliAdapter } from '@dutydeck/cli-adapters';
import type { AgentConfig } from '@dutydeck/shared';
import { discoverAgentModels } from '../agent-models.js';

export interface LarkLaunchOptions { agentId?: string; cwd?: string; model?: string; reasoningEffort?: string; workspaceMode?: 'shared' | 'worktree' }
export const larkNewSessionUsage = '/new [--agent Agent编号] [--cwd 绝对路径] [--workspace shared|worktree] [--model 模型] [--effort 强度] -- 任务内容';

/** Only the option header is tokenized; the task body is never shell-parsed. */
export function parseLarkNewSession(input: string): { prompt: string; launchOptions?: LarkLaunchOptions } {
  const body = input.trim();
  if (!body.startsWith('--')) return { prompt: body };
  const launchOptions: LarkLaunchOptions = {};
  const fields = { '--agent': 'agentId', '--cwd': 'cwd', '--model': 'model', '--effort': 'reasoningEffort', '--workspace': 'workspaceMode' } as const;
  let remaining = body;
  const invalid = () => new Error(`首轮参数格式不正确。用法：${larkNewSessionUsage}；路径含空格时用引号包围。`);
  const token = () => {
    const match = /^(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/u.exec(remaining);
    if (!match) throw invalid();
    remaining = remaining.slice(match[0].length).trimStart();
    return match[1] ?? match[2] ?? match[3]!;
  };
  while (remaining) {
    const flag = token();
    if (flag === '--') {
      if (!remaining.trim()) throw invalid();
      return { prompt: remaining.trimEnd(), ...(Object.keys(launchOptions).length ? { launchOptions } : {}) };
    }
    const field = fields[flag as keyof typeof fields];
    if (!field || launchOptions[field] !== undefined) throw invalid();
    const value = token();
    if (!value.trim() || value.startsWith('--')) throw invalid();
    if (field === 'workspaceMode') {
      if (value !== 'shared' && value !== 'worktree') throw invalid();
      launchOptions.workspaceMode = value;
    } else launchOptions[field] = value;
  }
  throw invalid();
}

export async function validateLarkLaunchOptions(
  options: LarkLaunchOptions,
  agent: Pick<AgentConfig, 'id' | 'name'> & Partial<AgentConfig>,
  /** 机器人配置里的「别名 → 绝对路径」表；非绝对路径的 --cwd 先查这张表，命中后仍走下面同一套校验。 */
  workspaceAliases?: Record<string, string>
): Promise<LarkLaunchOptions> {
  const result = { ...options };
  // 形态校验挡住明显不是 Agent 编号的输入；是否真实存在由调用方对着 runtime.listAgents 判断。
  if (result.agentId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(result.agentId)) throw new Error('Agent 编号格式不正确。');
  if (result.cwd) {
    // 绝对路径永远直通：别名表不得遮蔽用户明确写出的路径。命中别名后走的仍是同一套校验。
    // 查表必须用 hasOwn：直接下标会命中 Object.prototype 上的 constructor / toString 等，
    // 把一个函数当成路径交给下面的校验，用户拿到的就是英文 TypeError 而不是这里的中文提示。
    const alias = workspaceAliases && Object.hasOwn(workspaceAliases, result.cwd) ? workspaceAliases[result.cwd] : undefined;
    const requested = isAbsolute(result.cwd) ? result.cwd : alias ?? result.cwd;
    if (!isAbsolute(requested)) {
      const names = Object.keys(workspaceAliases ?? {});
      throw new Error(names.length ? `--cwd 必须是服务器上的绝对路径，或以下别名之一：${names.join('、')}。` : '--cwd 必须是服务器上的绝对路径。');
    }
    try {
      const canonical = await realpath(requested);
      if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
      result.cwd = canonical;
    } catch { throw new Error('--cwd 必须指向服务器上已存在的目录。'); }
  }
  if (result.model && !/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,127}$/u.test(result.model)) throw new Error('模型名称格式不正确。');
  if (result.reasoningEffort && !/^[a-z][a-z0-9_-]{0,31}$/u.test(result.reasoningEffort)) throw new Error('推理强度格式不正确。');
  if (!result.model && !result.reasoningEffort) return result;

  if (agent.protocol === 'pty-cli') {
    const adapter = getCliAdapter(agent.adapterId ?? agent.id);
    const context = { sessionId: '00000000-0000-4000-8000-000000000000', cwd: result.cwd ?? agent.cwd, permissionMode: agent.permissionMode };
    for (const [field, label] of [['model', '模型'], ['reasoningEffort', '推理强度']] as const) {
      if (!result[field]) continue;
      // Inspect the real launch contract instead of maintaining another CLI roster.
      if (!adapter || JSON.stringify(adapter.buildArgs({ ...context, [field]: result[field] })) === JSON.stringify(adapter.buildArgs(context))) {
        throw new Error(`${agent.name} 的启动参数不支持指定${label}。`);
      }
    }
    if (result.reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(result.reasoningEffort)) throw new Error('推理强度应为 none、minimal、low、medium、high 或 xhigh。');
  } else {
    if (agent.protocol !== 'acp' && agent.protocol !== 'auto') throw new Error('当前 Agent 协议不支持指定模型或推理强度。');
    if (!agent.command || !agent.args || !agent.env || !agent.protocol) throw new Error('当前运行时无法验证首轮模型配置，请先配置 Agent。');
    const available = await discoverAgentModels({ ...agent, ...(result.cwd ? { cwd: result.cwd } : {}) } as AgentConfig, result.model ?? agent.model);
    if (result.model && !available.models.some(item => item.id === result.model)) throw new Error('Agent 未提供所选模型，请检查模型名称或使用默认模型。');
    if (result.reasoningEffort && !available.reasoningEfforts.some(item => item.id === result.reasoningEffort)) throw new Error('所选模型未提供此推理强度。');
  }
  return result;
}
