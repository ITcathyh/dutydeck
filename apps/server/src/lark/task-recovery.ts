import { createHash } from 'node:crypto';
import type { AgentEvent, ConfigRepository } from '@dutydeck/shared';
import { withExplicitFinalLock } from './explicit-final.js';
import { sendLarkResult, type DeliveryTarget } from './result-delivery.js';
import { larkRelaunchLabels, larkReplayLabels } from './card-actions.js';
import { larkHeldReason, type LarkHeldCause } from './turn-redispatch.js';
import type { LarkCardService } from './service.js';
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

/** 恢复说明的收尾：原任务留在哪、谁去核对。卡上有 Web 详情入口时才指向 Web。 */
export const larkRecoveryRetainedNote = (webBaseUrl?: string) =>
  webBaseUrl ? '原任务已保留，可在 Web 详情里核对。' : '原任务已保留，管理员可以用 `dutydeck recovery` 命令核对。';

/**
 * Read-only projection: preserve the ledger state, expose no process/controller identifiers.
 *
 * options.relaunch 是调用方声明「这张卡能渲染转到新会话的按钮」。只有声明了且任务确实卡住，
 * 正文才提按钮；返回的 relaunch 就是按钮该不该出现，渲染端据此设 canRelaunch。
 * options.webBaseUrl 同理：只有卡上带详情链接时才传，否则正文不指向 Web。
 * options.interrupted：服务重启切断、停下等人选的一轮（见 coordinator.redispatchInterruptedTurn），显示为「结果未知」；
 * buttons 是卡上有没有「重新执行」「放弃」。
 */
export async function describeLarkTaskRecovery(runtime: LarkRuntime, sessionId: string, taskId: string, status: string, queuedAhead?: number,
  options: { relaunch?: boolean; webBaseUrl?: string; interrupted?: LarkHeldCause & { buttons?: boolean } } = {}) {
  const recovery = await runtime.getTaskRecovery?.(sessionId, taskId);
  status = recovery?.status ?? status;
  const resolvedUnknown = recovery?.resolvedUnknown === true;
  const needsReview = !resolvedUnknown && (status === 'reconcile_required' || status === 'legacy_unresolved');
  const blockers = recovery?.blockers ?? [];
  const blocked = needsReview || blockers.length > 0;
  const reasons = [...new Set(blockers.map(block => explanations[block.code] ?? '执行环境需要恢复检查'))];
  if (needsReview && options.interrupted) {
    const choose = options.interrupted.buttons ? `确认再做一次不会重复造成影响后点「${larkReplayLabels.replay_turn}」，不再需要就点「${larkReplayLabels.abandon_turn}」。` : '';
    return { blocked, label: '结果未知', relaunch: false,
      markdown: `**结果未知**\n\n服务重启打断了这一轮，执行结果未知。${larkHeldReason(options.interrupted)}${choose}${larkRecoveryRetainedNote(options.webBaseUrl)}\n\n发送 \`/status\` 查看最新状态。` };
  }
  const label = needsReview ? '需要核对' : blocked ? '排队受阻' : resolvedUnknown ? '已核对，结果未确认' : '排队中';
  const relaunch = options.relaunch === true && blocked && ['queued', 'reconcile_required', 'legacy_unresolved'].includes(status);
  const relaunchHint = !relaunch ? '' : status === 'queued'
    ? `可以点「${larkRelaunchLabels.run_in_new_session}」：取消这条排队请求，在本话题的新会话里执行原文，之后本话题的消息也进入新会话。`
    : `可以点「${larkRelaunchLabels.rerun_in_new_session}」在新会话里重新执行原请求。原执行结果未确认，重新执行可能把已经做过的操作再做一次。`;
  const detail = blocked
    ? `${reasons.join('；') || '本轮执行结果尚未确认'}。为避免重复执行，任务不会自动重放。${relaunchHint}${larkRecoveryRetainedNote(options.webBaseUrl)}`
    : resolvedUnknown ? '本轮已完成恢复检查，但执行结果未确认；旧请求不会重放，可以继续发送新请求。'
    : queuedAhead && queuedAhead > 0 ? `正在排队，前面还有 ${queuedAhead} 个任务…`
    : recovery?.activeTaskId ? '正在等待前一轮执行结束。' : '已进入执行队列，等待 Agent 开始。';
  const action = resolvedUnknown && !blocked ? '发送 `/status` 查看最新状态。' : status === 'queued' ? '此请求尚未执行，可点击取消，或回原话题发送 `/cancel`；发送 `/status` 查看最新状态。'
    : '发送 `/status` 查看最新状态。';
  return { blocked, label, relaunch, markdown: `**${label}**\n\n${detail}\n\n${action}` };
}

/** One durable exception notice per accepted task/turn, independent of business-final delivery. */
export async function notifyLarkTaskRecovery(input: {
  service: LarkCardService; store?: ConfigRepository; log: { warn: (...args: any[]) => void };
  appId: string; sessionId: string; taskId: string; turn?: number; target: DeliveryTarget;
  recovery: Pick<Awaited<ReturnType<typeof describeLarkTaskRecovery>>, 'blocked' | 'label' | 'markdown'>;
}) {
  if (!input.recovery.blocked) return;
  if (!input.store?.compareAndSet) throw new Error('Recovery notification requires persistent CAS');
  const store = input.store;
  const key = `recovery_${createHash('sha256').update(JSON.stringify([input.appId, input.sessionId, input.taskId, input.turn ?? 0])).digest('hex').slice(0, 40)}`;
  return withExplicitFinalLock(store, key, async () => {
    // Freeze the first notice before contacting the provider. Retry after a lost
    // response uses the same UUID and payload even when recovery facts change.
    const recordKey = `lark.recovery.${key}`;
    let saved = await store.get(recordKey);
    if (!saved) {
      const record = JSON.stringify({ target: input.target, markdown: input.recovery.markdown, label: input.recovery.label });
      await store.compareAndSet!(recordKey, saved, record);
      saved = await store.get(recordKey);
    }
    if (!saved) throw new Error('Recovery notification record was not saved');
    const record = JSON.parse(saved) as { target: DeliveryTarget; markdown: string; label: string };
    const sent = await sendLarkResult(input.service, { ...record.target, allowReplyFallback: false }, {
      taskId: input.taskId, taskName: '任务恢复提醒', sessionId: input.sessionId, turn: input.turn,
      state: 'reconcile_required', statusLabel: record.label, readOnly: true,
      capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false },
      elements: [{ tag: 'markdown', element_id: 'task_recovery_notice', content: record.markdown }],
      idempotencyKey: key
    }, input.log, store);
    return { messageId: sent.messageId, fingerprint: createHash('sha256').update(saved).digest('hex') };
  });
}

/** Only a ledger-backed manual completion can supersede historical open tools. */
export async function verifiedLarkRecoveryOutput(runtime: LarkRuntime, sessionId: string, taskId: string, events: AgentEvent[]) {
  const verified = (await runtime.getTaskRecovery?.(sessionId, taskId))?.verifiedOutput;
  if (!verified) return;
  const event = events.find(item => item.id === verified.eventId && item.type === 'text');
  const text = (event?.data as { text?: unknown } | undefined)?.text;
  if (!event || typeof text !== 'string' || createHash('sha256').update(text).digest('hex') !== verified.digest) {
    throw new Error('Verified recovery output is unavailable or does not match its receipt');
  }
  return event;
}
