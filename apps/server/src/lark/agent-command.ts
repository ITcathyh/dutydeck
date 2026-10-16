/**
 * Agent 代用户执行飞书命令：用户说人话，Agent 判断对应哪条 / 命令后调 `dutydeck command`，用户不用记命令。
 * 查看类以这一轮发起人的身份立即执行，结果卡发在请求消息下；会改东西的先发确认卡，点「确认」的人以自己的身份执行，带出的新一轮挂在确认卡下。
 * 两种都和在原话题里自己发这条命令走同一条路：授权、白名单、回执都不变（见 coordinator-inbound 的 agentCommand）。
 */
import { RuntimeError } from '@dutydeck/shared';
import { larkCommandRegistry, parseSlashCommand, resolveLarkCommand, type ParsedSlashCommand } from './commands.js';

/** 只能由用户自己做的：停止和插话针对 Agent 正在跑的这一轮，批准和回答是用户对 Agent 的答复；记忆另有 dutydeck memory。 */
const userOnly: Record<string, string> = {
  cancel: '停止当前任务要用户点进度卡上的「中断」，或直接说“停”。',
  steer: '插话要用户在你执行时直接发消息。',
  approve: '批准工具调用要用户在审批卡上点按钮，或回复“可以”。',
  reject: '拒绝工具调用要用户在审批卡上点按钮。',
  answer: '你的提问要用户在话题里直接回复。',
  remember: '记忆用 dutydeck memory add。',
  memory: '记忆用 dutydeck memory list/search。',
  forget: '记忆用 dutydeck memory remove。'
};
/** 自己会先发确认卡的命令，不再加一道确认。 */
const confirmsItself = new Set(['pr', 'repair']);
/** 不带参数时只是查看。 */
const viewWithoutArgs = new Set(['work', 'schedule', 'ci', 'queue']);

/** 代发命令确认卡的种类（confirm-cards.ts）：每个机器人一种，处理器由它的消息处理器登记。 */
export const larkAgentCommandKind = (appId: string) => `agent_command.${appId}`;

export interface LarkAgentCommandRequest { sessionId: string; taskId: string; actorId: string; command: string }
export type LarkAgentCommandHandler = (request: LarkAgentCommandRequest) => Promise<Record<string, unknown>>;

/** 各机器人的消息处理器在监听启动时登记；Agent 工具按会话所属的机器人转过去。 */
export class LarkAgentCommands {
  private readonly handlers = new Map<string, LarkAgentCommandHandler>();
  set(appId: string, handler: LarkAgentCommandHandler) { this.handlers.set(appId, handler); }
  delete(appId: string, handler: LarkAgentCommandHandler) { if (this.handlers.get(appId) === handler) this.handlers.delete(appId); }
  has(appId: string) { return this.handlers.has(appId); }
  run(appId: string, request: LarkAgentCommandRequest) {
    const handler = this.handlers.get(appId);
    if (!handler) throw new RuntimeError('AGENT_COMMAND_UNAVAILABLE', '这个机器人的飞书监听没有在运行，现在不能代办命令。', 503);
    return handler(request);
  }
}

/** 校验 Agent 给的命令；confirm 表示要先发确认卡。 */
export function agentCommandPlan(command: string): { parsed: ParsedSlashCommand; summary: string; confirm: boolean } {
  const parsed = parseSlashCommand(command);
  const definition = parsed && resolveLarkCommand(parsed);
  if (!parsed || !definition) throw new RuntimeError('AGENT_COMMAND_UNKNOWN', `不是 Dutydeck 命令：${command.trim().slice(0, 80)}。可用命令见 dutydeck command --help。`, 400);
  const reason = userOnly[definition.name];
  if (reason) throw new RuntimeError('AGENT_COMMAND_USER_ONLY', reason, 400);
  if (definition.name === 'schedule' && parsed.args[0] === 'every') throw new RuntimeError('AGENT_COMMAND_UNSUPPORTED', '新建定时任务用 dutydeck schedule request。', 400);
  return { parsed, summary: definition.summary, confirm: definition.mutating && !confirmsItself.has(definition.name) && !(viewWithoutArgs.has(definition.name) && !parsed.args.length) };
}

/** dutydeck command --help 列出的命令：和飞书里的 / 命令同一份注册表，去掉只能由用户自己做的。 */
export const agentCommandHelp = () => larkCommandRegistry.filter(definition => !userOnly[definition.name])
  .map(definition => `  ${definition.name === 'schedule' ? '/schedule；/schedule enable 编号；/schedule disable 编号（新建用 dutydeck schedule request）' : definition.usage}\n      ${definition.summary}`).join('\n');
