import { workPlanConfirmationRequired, type Session } from '@dutydeck/shared';
import { composePromptParts, type PromptContributor } from '../prompt/composer.js';
import { deliveryPrompt } from '../prompt-context.js';
import { collaborationAgentPrompt } from '../collaboration-cli.js';
import { layeredWorkbenchPrompt, workbenchAgentPrompt } from '../work-item-tools.js';
import { stableMemoryCommand } from '../agent-host/stable-command.js';
import { larkMemoryToolsPrompt } from './memory.js';
import type { StoredLarkConfig } from './config.js';

const scheduleRequestPrompt = '定时任务：用户要定时或周期性做的事（如“每天 9 点汇总”“每 15 分钟看看有没有结论”“明天 10 点提醒我”）由你直接设置：schedule create 加 --every <分钟数>、--cron \'<五段 cron>\' 或 --at YYYY-MM-DDTHH:mm 其中一个，再加 --prompt \'<到点后要执行的完整指令，只写每次要做的事，不写频率>\'，时间按北京时间；用户点「启用」才开始，结果发回当前对话。修改已有计划先用 schedules 查编号，再用 schedule update <编号> 修改时间或内容；启停用 schedule enable/disable <编号>。同事项已有生效循环计划时，确需再建才加 --additional。循环任务默认每次在新会话里执行，不带本对话历史，只带上一次结果的摘要；只有用户明确要求接着上次的对话做时才加 --mode session。同一原因连续 3 次没做成会自动停用，用户说恢复时先用 schedules 查编号，再 schedule enable <编号>。需要试跑就在本轮直接执行一次，不要建“测试任务”（它会占住计划、挡住正式任务）。不要用 crontab、后台 sleep 或循环脚本代替。';
const agentCommandPrompt = 'Dutydeck 操作由你代办，不要让用户自己发命令：查看状态、Agent、任务、排队、定时任务、CI 等待用 status、agents、tasks、queue、schedules、ci（直接返回数据，不发卡）；换 Agent、模型或工作目录重新做用 session new --agent <Agent编号> --task \'<完整任务>\'（新对话不带当前上下文，任务要写全；要带上当前进展加 --handoff；编号填错时会返回可用编号），重试用 retry，先出计划用 plan --task，开 PR 用 pr open；其余见 dutydeck agent --help。改东西的命令先发确认卡，用户点「确认」才执行；不确定时加 --dry-run 预览。';
const userOnlyPrompt = '停止当前任务、批准工具调用、回答你的提问只能由用户做：停止点进度卡上的“中断”或说“停”，批准点审批卡上的按钮或说“可以”，回答直接在话题里回复。';
/** 没有代办入口时的说法：这些由用户自己操作。 */
export const larkCapabilityPrompt = (cannotSchedule: boolean) => `[Dutydeck 能力限制与操作指引] 下面这些由用户自己操作，遇到时在回复里给出做法，不要说“已完成”或“已设置”：${cannotSchedule ? '定时任务用 /schedule（如 /schedule every 分钟 指令），不要用 crontab、后台 sleep 或循环脚本代替；' : ''}切换 agent、模型或工作目录用 /new [--agent Agent编号] [--cwd 绝对路径] [--workspace shared|worktree] [--model 模型] [--effort 强度] -- 任务内容；查看任务用 /tasks；停止当前任务点进度卡上的“中断”；重新开始用 /new。`;

/** 每轮工具块的开头：完整绑定命令只在这里出现一次，最终答复的交付方式也只在这里说。 */
export const larkCommandPrompt = (command: string, delivery: string, turn?: string) => `[Dutydeck 命令] ${turn ? `本轮完整 Agent 命令前缀是 ${command} agent --turn ${turn}，下文的 dutydeck agent 都指此前缀：原样使用，不换成 PATH 里的 dutydeck，不从历史提示借用凭证。` : `${command === 'dutydeck' ? '' : `本会话的 dutydeck 命令是 ${command}，下文的 dutydeck 都指它：原样使用，不要换成 PATH 里的 dutydeck。`}本轮没有任务尝试凭证，不能执行 Agent 操作。`}下列能力使用 dutydeck agent，先看 dutydeck agent --help；子命令加 --help 看参数、风险和例子。帮助不需要服务或凭证。
${delivery}`;

/** 群工具的能力行，只列本轮确实可用的入口；消息范围、cursor、幂等键、交接格式等细节在 dutydeck agent group --help 里。 */
export const larkGroupToolsPrompt = (allowSend: boolean, access = { read: true, discover: true }) => [
  ...(access.read ? ['读取消息/任务历史：group messages/message、history list/show；回答以前讨论过的结论先查历史，查不到或结果标 truncated 时不等于不存在。跨群资料：group team-search。'] : []),
  ...(access.discover ? ['发现成员/机器人：group peers/members/bots。'] : []),
  ...(allowSend ? ['发送独立消息/文件：group send/send-file。交付文件用 send-file；要接在某条消息下用 --reply-to <om_* message_id> --in-thread。'] : [])
].map((line, index) => index ? line : `[Dutydeck 飞书会话工具] ${line}`);

interface ToolPromptContext {
  command: string;
  turn?: string;
  config: StoredLarkConfig;
  collaborationSession: boolean;
  memory: boolean;
  read: boolean;
  discover: boolean;
  send: boolean;
  finalDelivery: boolean;
  handoff: boolean;
  work: boolean;
  collaboration: boolean;
  schedule: boolean;
  commands: boolean;
  stopSelf: boolean;
}

export async function larkToolPromptParts(session: Session, context: ToolPromptContext) {
  const { config, collaborationSession, memory, read, discover, send, work, collaboration, schedule, commands } = context;
  const workbench = config.executionMode === 'layered' && !collaborationSession ? layeredWorkbenchPrompt : workbenchAgentPrompt;
  const groupTools = read || discover || send;
  const rules = [
    ...(send ? ['群里发消息：独立消息只在用户要求或需要通知指定的人时发；不要回应自己发的消息，不和其他机器人互相礼貌 @，一次请求最多主动交接两跳。'] : []),
    ...(groupTools ? ['工具返回 GROUP_TOOL_AUTHORIZATION_REQUIRED 时停止操作，把 instruction 和 authorizationUrl 告诉用户，由管理员开通权限；不运行 lark-cli auth login，不索要密钥。'] : []),
    ...(schedule || commands || collaboration || work ? ['返回 confirmationDelivery:failed 时，按 message 说明计划已保存但发卡失败，并给用户恢复办法。其他 pendingConfirmation:true 表示已发确认卡：只回一句已发确认卡、点确认后生效，不要说已完成或已设置，也不要让用户自己发命令。'] : []),
    ...(commands ? [userOnlyPrompt] : []),
    ...(config.silentProgress ? ['本会话不显示中间进度，不要另发进度消息；提问和最终结果不受影响。'] : [])
  ];
  // The first ability opens the list. Later abilities share its heading and each block keeps its original separator.
  let startedList = false;
  function entry(order: number, content: string | undefined, list = false): PromptContributor {
    return { stage: 'capability', order, sessions: 'all', contribute: previous => {
      if (!content) return [];
      let prefix = previous.length ? '\n\n' : '';
      if (list) {
        prefix = startedList ? '\n- ' : '\n\n本轮可用（都在 dutydeck agent 下）：\n- ';
        startedList = true;
      }
      return [{ kind: 'dynamic_context', trustScope: 'host:current_authority', content, prefix }];
    } };
  }
  const parts = await composePromptParts(session, [
    entry(10, larkCommandPrompt(stableMemoryCommand(context.command), deliveryPrompt({ background: collaborationSession, reactionOnly: config.completionReactionOnly }), context.turn)),
    entry(20, memory ? larkMemoryToolsPrompt('dutydeck agent') : undefined, true),
    entry(30, larkGroupToolsPrompt(send, { read, discover }).join('\n- '), true),
    entry(40, context.finalDelivery ? '主动最终交付（一般用不到）：group send \'<完整答复>\' --final，默认发布；--card-file <JSON文件> 可用静态 Card 2.0 body（content 写可检索摘要），--delivery publish|reply-agent|both 选择发布、仅向原交接机器人回传、或两者都做。绑定本轮与原消息，不加 --to 或自定义幂等键；重试保留全部内容与模式。进展和交接不加 --final。' : undefined, true),
    entry(50, context.handoff ? '单次 Agent 交接：group handoff <机器人名称/appId/openId> \'<目标、代码版本、工作区、读写边界和验收>\'；收到交接后用 group reply-agent \'<交付结果>\' 回传一次；多轮审查返修用 work。' : undefined, true),
    entry(60, work ? workbench('dutydeck agent work', workPlanConfirmationRequired(session)) : undefined, true),
    entry(70, collaboration ? collaborationAgentPrompt('dutydeck agent collaborate') : undefined, true),
    entry(80, schedule ? scheduleRequestPrompt : undefined, true),
    entry(90, context.stopSelf ? '周期任务达到用户要求的停止条件时，可用 schedule stop-self 请求停用自身计划；宿主只在本轮成功且结果确认送达后停用。此命令不能指定其他计划，也不会删除历史；失败或投递未知不会停用。' : undefined, true),
    entry(100, commands ? agentCommandPrompt : undefined, true),
    entry(110, rules.length ? `规则：\n${rules.map(line => `- ${line}`).join('\n')}` : undefined),
    entry(120, commands ? undefined : larkCapabilityPrompt(!collaboration && !schedule))
  ]);
  // The command block is always present after a Lark binding and its bot configuration were resolved.
  parts[parts.length - 1]!.suffix = '\n\n';
  return parts;
}
