/**
 * 中文说法评测（scripts/nl-control-eval.mjs）专用：用线上同一份 LarkAgentToolsService.promptForSession
 * 拼注入说明，不手抄提示文本。内存配置、不连任何服务。
 */
import { createRepositories } from '@dutydeck/storage';
import type { Session } from '@dutydeck/shared';
import { larkBotsConfigKey } from './lark/config.js';
import { LarkAgentToolCapabilityRegistry, LarkAgentToolsService } from './lark/agent-tools.js';

export interface EvalPromptOptions {
  /** 群聊或私聊。 */
  chatType: 'group' | 'p2p';
  /** 用户这一轮的大白话。 */
  userPrompt: string;
  /** 是否有正在进行、由真人发起的任务（false 时没有代办入口，提示变为用户自己操作）。 */
  activeTask?: boolean;
}

/**
 * 构造评测用注入提示：等价于一个开了群工具、记忆、定时委托和 agent 代办命令的飞书机器人，
 * 在真人发起的活跃轮次里给 Agent 的完整说明，末尾接上用户消息。
 */
export async function buildEvalPrompt({ chatType, userPrompt, activeTask = true }: EvalPromptOptions): Promise<string> {
  const repos = createRepositories(':memory:');
  try {
    const chatId = chatType === 'group' ? 'oc_eval_group' : 'oc_eval_p2p';
    const session: Session = {
      id: 'ses_eval', agentId: 'codex', state: 'running_tool', cwd: '/tmp/eval-workspace',
      source: 'lark', sourceId: `cli_eval:${chatId}:${chatType}`,
      runId: 'run_eval', createdAt: '', updatedAt: ''
    };
    await repos.sessions.save(session);
    await repos.config.set(larkBotsConfigKey, JSON.stringify([{
      appId: 'cli_eval', appSecret: 'eval-secret', name: 'Eval Bot', defaultAgentId: 'codex',
      groupToolsEnabled: true, groupToolsAllowSend: true, memoryEnabled: true
    }]));
    const capabilities = new LarkAgentToolCapabilityRegistry(repos.sessions, 'http://127.0.0.1:0');
    const tools = new LarkAgentToolsService(capabilities, repos.config, {
      scheduleRequests: true,
      ...(activeTask ? { workbenchTask: () => ({ taskId: 'task-eval', attemptId: 'attempt-eval', actorId: 'ou_eval' }) } : {}),
      // 不开 work/collaboration，保持标准代办提示（collaboration 会让定时入口消失）。
      previewWork: async () => false,
      previewCollaboration: async () => false
    });
    // 模拟该机器人的飞书监听已注册代办命令处理器。
    tools.commands.set('cli_eval', async () => ({}));
    return await tools.promptForSession(session, userPrompt);
  } finally {
    repos.close();
  }
}
