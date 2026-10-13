import type { LarkCardElement } from './card-renderer.js';
import type { LarkMessageEvent } from './listener.js';
import type { LarkInteraction } from './workflow-interactions.js';
import { planApprovedPrompt, planRevisePrompt } from '../plan-mode.js';

/** 飞书里的先出计划：计划轮结束后的结果卡带上计划操作，批准或提修改意见时以操作人身份在原话题提交下一轮。 */
export type LarkPlanDecision = 'approve' | 'revise' | 'cancel';

export const planStaleText = '会话里已经有更新的任务，这份计划不再能批准或修改。需要的话请重新发送 /plan。';

const shanghaiTime = (at: string) => `${new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`;

const callback = (record: LarkInteraction, action: string) => ({ type: 'callback', value: { dutydeck_workflow: action, request_id: record.id, generation: record.boot } });

/** 待处理计划卡上的说明、「批准执行」「取消」与修改意见表单。element_id 都以 workflow_plan_ 开头，长结果转附件时随摘要卡保留。 */
export function planPendingElements(record: LarkInteraction): LarkCardElement[] {
  return [
    { tag: 'markdown', element_id: 'workflow_plan_status', content: `**以上是执行计划，Agent 还没有改任何东西。**\n批准后在同一会话按计划执行；要调整就写下修改意见，Agent 会重新出计划。${record.expiresAt ? `\n30 分钟无人处理会提醒一次，${shanghaiTime(record.expiresAt)}前未处理则计划卡失效。` : ''}` },
    { tag: 'button', element_id: 'workflow_plan_approve', type: 'primary', text: { tag: 'plain_text', content: '批准执行' }, behaviors: [callback(record, 'plan_approve')] },
    { tag: 'button', element_id: 'workflow_plan_cancel', type: 'default', text: { tag: 'plain_text', content: '取消' }, behaviors: [callback(record, 'plan_cancel')] },
    { tag: 'form', element_id: 'workflow_plan_form', name: `workflow_plan_${record.id}`, direction: 'vertical', vertical_spacing: '8px', margin: '0px',
      elements: [
        { tag: 'input', element_id: 'workflow_plan_input', name: 'answer', input_type: 'multiline_text', max_length: 1000,
          placeholder: { tag: 'plain_text', content: '写下要怎么改这份计划' } },
        { tag: 'button', element_id: 'workflow_plan_revise', type: 'default', text: { tag: 'plain_text', content: '提修改意见' }, form_action_type: 'submit',
          behaviors: [callback(record, 'plan_revise')] }
      ] },
    { tag: 'markdown', element_id: 'workflow_plan_hint', content: '也可以引用这张卡回复：回复「批准」执行，回复「取消」作废，其他内容按修改意见处理。' }
  ];
}

/** 计划卡处理后的那一行。 */
export function planClosedText(record: LarkInteraction): string {
  if (record.state === 'approved') return '计划：已批准，正在按计划执行。';
  if (record.state === 'needs_changes') return '计划：已提修改意见，Agent 会重新出计划。';
  if (record.state === 'rejected') return '计划：已取消，不会执行。';
  if (record.state === 'expired') return record.timedOutAt ? '计划：超过 24 小时未处理，已失效。' : `计划：${planStaleText}`;
  return '计划：正在提交…';
}

/** 引用计划卡回复的文字：「批准」「取消」按按钮处理，其余当修改意见。 */
export function planReplyAction(text: string): 'plan_approve' | 'plan_cancel' | 'plan_revise' {
  const reply = text.trim();
  if (['批准', '批准执行', '同意', '执行'].includes(reply)) return 'plan_approve';
  if (['取消', '不执行'].includes(reply)) return 'plan_cancel';
  return 'plan_revise';
}

/**
 * 计划卡决定后的下一轮：把计划卡本身当作操作人发来的消息（与结果卡一键续问同一做法），
 * 唤醒、授权、排队与会话复用都走原路；入站记录按卡片消息 ID 去重，同一张卡只会提交一次。
 */
export function planFollowUpEvent(record: LarkInteraction, origin: { chatId: string; chatType: string; threadId?: string }, bot: { name: string; openId?: string }): { event: LarkMessageEvent; prompt: string } {
  const prompt = record.decision === 'approve' ? planApprovedPrompt : planRevisePrompt(record.feedback ?? '');
  return { prompt, event: {
    messageId: record.cardId!, chatId: origin.chatId, chatType: origin.chatType, ...(origin.threadId ? { threadId: origin.threadId } : {}),
    createTime: String(Date.now()), messageType: 'text', content: JSON.stringify({ text: `@_user_1 ${prompt}` }),
    senderOpenId: record.actorId, senderType: 'user',
    mentions: [{ key: '@_user_1', name: bot.name, ...(bot.openId ? { openId: bot.openId } : {}), mentionedType: 'bot' }]
  } };
}
