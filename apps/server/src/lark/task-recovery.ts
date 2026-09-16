import type { LarkRuntime } from './listener.js';

const explanations: Record<string, string> = {
  DRIVER_RESOURCE_UNSAFE: '原执行进程尚未确认安全停止',
  DRIVER_STOP_BLOCKED: '上次停止执行进程未成功',
  WORKSPACE_RECOVERY_REQUIRED: '工作区需要恢复检查',
  VERIFICATION_RESOURCE_UNKNOWN: '验证进程状态尚未确认',
  LEGACY_MULTIPLE_EXECUTIONS: '历史执行记录需要核对',
  INPUT_OPTIONS_UNVERIFIABLE: '历史请求的执行选项无法验证',
  INPUT_SNAPSHOT_UNVERIFIABLE: '历史请求内容无法验证',
  PREVIOUS_RESULT_UNKNOWN: '前一轮执行结果尚未确认',
  QUEUE_START_CHECK_FAILED: '任务启动检查未通过'
};

/** Read-only projection: preserve the ledger state, expose no process/controller identifiers. */
export async function describeLarkTaskRecovery(runtime: LarkRuntime, sessionId: string, taskId: string, status: string, queuedAhead?: number) {
  const needsReview = status === 'reconcile_required' || status === 'legacy_unresolved';
  const recovery = await runtime.getTaskRecovery?.(sessionId, taskId);
  const blockers = recovery?.blockers ?? [];
  const blocked = needsReview || blockers.length > 0;
  const reasons = [...new Set(blockers.map(block => explanations[block.code] ?? '执行环境需要恢复检查'))];
  const label = needsReview ? '需要核对' : blocked ? '排队受阻' : '排队中';
  const detail = blocked
    ? `${reasons.join('；') || '本轮执行结果尚未确认'}。为避免重复执行，任务不会自动重放。请联系管理员核对原进程和执行结果，完成恢复检查。`
    : queuedAhead && queuedAhead > 0 ? `正在排队，前面还有 ${queuedAhead} 个任务…`
    : recovery?.activeTaskId ? '正在等待前一轮执行结束。' : '已进入执行队列，等待 Agent 开始。';
  const action = status === 'queued' ? '此请求尚未执行，可点击取消，或回原话题发送 `/cancel`；发送 `/status` 查看最新状态。'
    : '当前不能确认任务已停止；请勿直接重试。发送 `/status` 查看最新状态。';
  return { blocked, label, markdown: `**${label}**\n\n${detail}\n\n${action}` };
}
