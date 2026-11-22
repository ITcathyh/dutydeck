import type { CallbackHandler } from './button-context.js';

export const confirm: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  const participation = ctx.participation;
  const result = participation && ctx.reconcileConfig ? await participation.confirmations.handle(ctx.reconcileConfig.appId, workflow, operatorOpenId, context) : undefined;
  return result ?? { type: 'warning', content: '这张确认卡已失效。' };
};

export const queuedApproval: CallbackHandler = async (ctx, { workflow, operatorOpenId, context }) => {
  const { dutydeck_queued_task: queuedTaskId, queued_turn: queuedTurn, ...approval } = workflow;
  return ctx.respondFromQueuedCard({ taskId: queuedTaskId as string, turn: queuedTurn }, approval, operatorOpenId, context?.messageId,
    (): Promise<{ type: string; content: string }> => ctx.handleAction(approval, operatorOpenId, context));
};

export const workflowAction: CallbackHandler = async (ctx, { workflow, operatorOpenId, context, key }) => {
  if (!context?.messageId || !context.chatId || !ctx.reconcileConfig) return { type: 'error', content: '卡片身份不完整或已失效。' };
  const action = workflow[key] as string;
  if (!['approve', 'reject', 'accept', 'changes', 'answer', 'allow_session', 'allow_workspace', 'plan_approve', 'plan_revise', 'plan_cancel'].includes(action)) return { type: 'error', content: '无法识别任务操作。' };
  // P0-1：overflow 菜单只承载唯一的回调选项（审批行的「拒绝」），其余点选一律拒绝，
  // 防止共用 behaviors.value 被误当成任意动作执行。
  if (context.actionTag === 'overflow' && !(action === 'reject' && context.option === 'reject')) {
    return { type: 'error', content: '该菜单不支持此操作。' };
  }
  try {
    const requestId = String(workflow.request_id ?? '');
    // 区分原审批卡回调与 /tasks 行内审批：后者记录的 cardId 是另一张审批卡，
    // 走斜杠形态（不做 cardId/generation 回调校验），但世代必须与渲染时一致。
    // 决议的一次性 CAS、liveness、授权仍全部由 respond 内部保证，不存在旁路。
    const record = (await ctx.workflows.list(ctx.reconcileConfig.appId)).find(item => item.id === requestId);
    const fromDashboard = !record?.cardId || record.cardId !== context.messageId;
    // 非原审批卡的回调只可能来自已登记的 /tasks 卡：行内按钮的 value 与原卡按钮同形，
    // 不验卡来源就等于接受任意 messageId 上的伪造回调。kv 在发送 /tasks 时持久化。
    if (fromDashboard) {
      const dashboardOrigin = await ctx.store.get(
        `lark.task_dashboard.${ctx.reconcileConfig.appId}.${context.messageId}`);
      if (!dashboardOrigin) return { type: 'error', content: '请在最新的审批卡片或 /tasks 卡片上操作。' };
    }
    if (fromDashboard && String(workflow.generation ?? '') !== record?.boot) {
      return { type: 'warning', content: '审批已失效，请刷新 /tasks 后重试。' };
    }
    let answer: { answer?: string; reason?: string; selected?: string[]; other?: string } = {};
    if (action === 'reject') {
      // 「拒绝并说明」表单的输入在 form_value.reason；普通「拒绝」按钮没有 form_value。
      const formReason = (workflow.form_value as { reason?: unknown } | undefined)?.reason;
      if (typeof formReason === 'string') answer = { reason: formReason };
    }
    if (action === 'plan_revise') {
      const formAnswer = (workflow.form_value as { answer?: unknown } | undefined)?.answer;
      answer = { answer: typeof formAnswer === 'string' ? formAnswer : '' };
    }
    if (action === 'answer') {
      if (workflow.multiple === true) {
        // 多选值由平台放在 form_value.answer（string[]）；容忍单值形态，过滤去重在 respond 内。
        const formValue = workflow.form_value as { answer?: unknown; other?: unknown } | undefined;
        const raw = formValue?.answer;
        // 「其他」输入在 form_value.other；旧卡片没有这个字段。
        answer = { selected: Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [],
          ...(typeof formValue?.other === 'string' ? { other: formValue.other } : {}) };
      } else if (workflow.other === true) {
        // 单选卡的「其他」表单：回调带 other:true，文字在 form_value.other；点选项按钮没有这个标记。
        const formOther = (workflow.form_value as { other?: unknown } | undefined)?.other;
        answer = { other: typeof formOther === 'string' ? formOther : '' };
      } else {
        // 单选按钮直接带 answer；自由文本 input 的提交值在 form_value.answer。
        const formAnswer = (workflow.form_value as { answer?: unknown } | undefined)?.answer;
        answer = { answer: typeof workflow.answer === 'string' ? workflow.answer
          : typeof formAnswer === 'string' ? formAnswer : '' };
      }
    }
    const content = await ctx.workflows.respond({ appId: ctx.reconcileConfig.appId, chatId: context.chatId, deferClose: true,
      actorId: operatorOpenId, requestId, action: action as 'answer' | 'approve' | 'reject' | 'accept' | 'changes' | 'allow_session' | 'allow_workspace' | 'plan_approve' | 'plan_revise' | 'plan_cancel',
      ...(fromDashboard ? {} : { cardId: context.messageId, generation: String(workflow.generation ?? ''), callback: true }),
      ...answer });
    if (action === 'accept' || action === 'changes') await ctx.refreshResultFeedback(ctx.reconcileConfig, requestId).catch(error => ctx.log.warn({ error }, '验收已记录，卡片刷新失败'));
    return { type: 'success', content };
  } catch (error) { return { type: 'error', content: error instanceof Error ? error.message : String(error) }; }
};
