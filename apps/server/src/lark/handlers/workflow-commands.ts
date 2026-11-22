import { LarkServiceError } from '../service.js';
import { resolveLarkScopeId } from '../session-resolver.js';
import type { ParsedSlashCommand } from '../commands.js';
import type { WorkflowServices } from './service-context.js';
import type { LarkCommandReceipts } from '../coordinator-inbound.js';
import type { LarkMessageEvent } from '../listener.js';
import type { StoredLarkConfig } from '../config.js';
import type { LarkInteraction } from '../workflow-interactions.js';

interface WorkflowInput {
  event: LarkMessageEvent;
  config: StoredLarkConfig;
  scope: { id: string; prompt?: string };
  prompt: string;
  quoted?: LarkInteraction;
  parsed?: ParsedSlashCommand;
  receipts?: LarkCommandReceipts;
}
export type WorkflowCommandHandler = (ctx: WorkflowServices, input: WorkflowInput) => Promise<boolean>;

export const tasks: WorkflowCommandHandler = async (ctx, { event, config, parsed, receipts }) => {
  const elements = await ctx.taskDashboard(event, config, Number(parsed!.args[0] ?? 1));
  if (receipts?.capture) { receipts.cards.push({ title: '任务导航', markdown: '', failed: false, elements }); return true; }
  const card = await ctx.workflowReply(event, config, '', { taskName: '任务导航', elements });
  await ctx.saveTaskDashboardOrigin(config, card, event);
  return true;
};

function respond(action: 'answer' | 'approve' | 'reject'): WorkflowCommandHandler {
  return async (ctx, { event, config, parsed, prompt, quoted, scope }) => {
    const explicit = parsed && ['answer', 'approve', 'reject'].includes(parsed.name);
    if (quoted && quoted.kind !== 'ask' && action === 'answer') throw new LarkServiceError('LARK_APPROVAL_EXPLICIT', '审批请使用按钮或明确的 /approve、/reject 命令。', 400);
    // 显式编号优先，其次回落到被引用的那张卡。请求编号不再印在卡片正文里
    // （审批卡下方就是按钮，编号对能点按钮的人是噪声），所以「引用那张卡 + /approve」
    // 必须能走通——否则删掉编号就等于删掉了按钮失灵时的唯一备用路径。
    const requestId = (explicit ? parsed!.args[0] : undefined) ?? quoted?.id;
    if (!requestId) throw new LarkServiceError('LARK_REQUEST_REQUIRED', '请回复要处理的那张卡片，或直接用卡片上的按钮。', 400);
    const answer = parsed?.name === 'answer' ? parsed.argsText.slice(parsed.args[0]?.length ?? 0).trim() : prompt;
    let result: string;
    try { result = await ctx.workflows.respond({ appId: config.appId, chatId: event.chatId, actorId: event.senderOpenId, requestId, action, answer }); }
    catch (error) {
      const handover = ctx.expiredAskPrompt(error, answer);
      if (!handover) throw error;
      // 过期提问的回复回到原提问所在的会话，作为一条新消息交给 Agent。
      scope.prompt = handover;
      if (quoted) scope.id = await resolveLarkScopeId(quoted.event, config, ctx.chatModeResolver);
      return false;
    }
    await ctx.workflowReply(event, config, result);
    return true;
  };
}

export const answer = respond('answer');
export const approve = respond('approve');
export const reject = respond('reject');
