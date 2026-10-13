import { createHash } from 'node:crypto';
import { AGENT_IDLE_TIMEOUT, AGENT_LOGIN_REQUIRED, unknownTaskActionLabels, unknownTaskRetryWarning, type AgentEvent, type ConfigRepository, type UnknownTaskFacts } from '@dutydeck/shared';
import { unknownTaskFactLines } from '../task-resolution.js';
import { withExplicitFinalLock } from './explicit-final.js';
import { sendLarkResult, type DeliveryTarget } from './result-delivery.js';
import { larkRelaunchLabels, larkReplayLabels } from './card-actions.js';
import { isRestartInterruption, larkHeldReason, larkInterruptionSummary, type LarkHeldCause } from './turn-redispatch.js';
import type { LarkCardService } from './service.js';
import type { LarkUrgentManager } from './workflow-urgent.js';
import type { LarkRuntime } from './listener.js';

const explanations: Record<string, string> = {
  DRIVER_RESOURCE_UNSAFE: '上一轮的 Agent 还没确认停下',
  DRIVER_STOP_BLOCKED: '上次停止 Agent 没有成功',
  WORKSPACE_RECOVERY_REQUIRED: '工作目录需要先检查',
  VERIFICATION_RESOURCE_UNKNOWN: '验证命令还没确认停下',
  LEGACY_MULTIPLE_EXECUTIONS: '旧版本留下的执行记录需要核对',
  INPUT_OPTIONS_UNVERIFIABLE: '旧版本留下的请求无法核对',
  INPUT_SNAPSHOT_UNVERIFIABLE: '旧版本留下的请求无法核对',
  PREVIOUS_RESULT_UNKNOWN: '上一轮还不确定是否做完',
  QUEUE_START_CHECK_FAILED: '开始执行前的检查没通过'
};

/** 这一轮因无进展超时停下的分钟数（驱动发的 AGENT_IDLE_TIMEOUT error 事件，data.timeoutMinutes）；不是这样停下的返回 undefined。 */
export function larkIdleTimeoutMinutes(events: AgentEvent[]): number | undefined {
  const event = [...events].reverse().find(item => item.type === 'error' && (item.data as { code?: unknown } | undefined)?.code === AGENT_IDLE_TIMEOUT);
  if (!event) return undefined;
  const minutes = (event.data as { timeoutMinutes?: unknown }).timeoutMinutes;
  return typeof minutes === 'number' && minutes > 0 ? minutes : 0;
}

/** 「在原对话继续」交给 Agent 的说明：上一轮怎么停的，接着做、不要重复。不附原请求，原请求已在原对话里。 */
export const larkContinuePrompt = (cause: { code?: string; minutes?: number }) => `[Dutydeck 系统说明]\n${
  cause.code === AGENT_IDLE_TIMEOUT ? `上一轮因 ${cause.minutes ? `${cause.minutes} 分钟` : '长时间'}无输出被系统停止。`
  : isRestartInterruption(cause.code) ? '上一轮因服务重启中断。'
  : cause.code === 'DRIVER_INPUT_UNCONFIRMED' ? '上一轮的消息可能没有送到你这里。'
  : cause.code === AGENT_LOGIN_REQUIRED ? '上一轮因为没登录，消息没有处理。'
  : '上一轮被中断了。'}请先确认上一轮做到了哪一步，然后在这个对话里接着做完，不要重复已经完成的操作。`;

/** Agent 停下后自动结束的那一轮，结果卡上补的说明。 */
export const larkQuietSettledNote = (cause: { code?: string; agent?: string }) =>
  `${larkInterruptionSummary(cause.code, cause.agent)}Agent 已经停下，这一轮也没有做过可能对外生效的操作，已自动结束。直接发下一条消息就会在原对话里继续。`;
/** 旧的一轮在对账时自动结束：不发结果卡，原来的过程卡原地改成终态，写上这一句。 */
export const larkStaleSettledNote = '服务重启前没有完成，已自动结束。';

/** 运行时上这次新增的可选能力。listener.ts 的 LarkRuntime 不在这次改动范围内，按可选能力读取。 */
export type LarkRuntimeReliability = {
  getAgentAvailability?(agentId: string): { reason: string; remedy: string; at: string } | undefined;
  checkAgentAvailability?(agentId: string, options?: { force?: boolean }): Promise<{ reason: string; remedy: string; at: string } | undefined>;
  inspectAgentQuiescence?(sessionId: string): 'idle' | 'busy' | 'unknown';
  settleIdleAttempt?(sessionId: string, input: { taskId: string; decisionId: string; outcome: 'unknown' | 'interrupted' | 'failed'; evidenceRefs: string[] },
    actor: { kind: 'installation_owner'; id: string }): Promise<unknown>;
};
export const larkReliability = (runtime: LarkRuntime) => runtime as LarkRuntime & LarkRuntimeReliability;

/** Agent 不可用时在话题里回的那句话（A1）。 */
export const larkAgentUnavailableText = (botName: string, unavailable: { reason: string; remedy: string }) =>
  `${botName} 现在用不了：${unavailable.reason}。${unavailable.remedy}。修好后重发这条消息即可。`;

/** 恢复说明的收尾：原任务留在哪、谁去核对。卡上有 Web 详情入口时才指向 Web。 */
export const larkRecoveryRetainedNote = (webBaseUrl?: string) =>
  webBaseUrl ? '原任务已保留，可在 Web 详情里核对。' : '原任务已保留，管理员可以用 `dutydeck recovery` 命令核对。';

/** 执行卡上的「可能卡住」注记，分钟数随心跳更新。 */
export const larkStallNote = (stall: { silentMs: number; queued: number; cpu: 'inactive' | 'unknown' }) =>
  `<font color='orange'>**可能卡住**</font>　已经 ${Math.floor(stall.silentMs / 60_000)} 分钟没有新的输出${stall.cpu === 'inactive' ? '，进程也没有在占用 CPU' : ''}，`
  + `后面还有 ${stall.queued} 条请求在排队。Dutydeck 不会自动中断；确认卡住的话可以点「中断」，排队的请求也可以在各自的卡上点「${larkRelaunchLabels.run_in_new_session}」。`;

/**
 * Read-only projection: preserve the ledger state, expose no process/controller identifiers.
 *
 * options.relaunch 是调用方声明「这张卡能渲染转到新会话的按钮」。只有声明了且任务确实卡住，
 * 正文才提按钮；返回的 relaunch 就是按钮该不该出现，渲染端据此设 canRelaunch。
 * options.webBaseUrl 同理：只有卡上带详情链接时才传，否则正文不指向 Web。
 * options.interrupted：服务重启切断、停下等人选的一轮（见 coordinator.redispatchInterruptedTurn），显示为「结果未知」；
 * buttons 是卡上有没有「重新执行」「放弃」。
 * 排在一轮可能卡住的任务后面（stalled）只是提示：不算受阻、不发恢复提醒，但同样给转到新会话的按钮——它从未执行，换过去不会重复任何操作。
 */
export async function describeLarkTaskRecovery(runtime: LarkRuntime, sessionId: string, taskId: string, status: string, queuedAhead?: number,
  options: { relaunch?: boolean; webBaseUrl?: string; interrupted?: LarkHeldCause & { buttons?: boolean }; continueInPlace?: boolean } = {}) {
  const recovery = await runtime.getTaskRecovery?.(sessionId, taskId);
  status = recovery?.status ?? status;
  const resolvedUnknown = recovery?.resolvedUnknown === true;
  const needsReview = !resolvedUnknown && (status === 'reconcile_required' || status === 'legacy_unresolved');
  const blockers = recovery?.blockers ?? [];
  const blocked = needsReview || blockers.length > 0;
  // 前面那一轮结果未知时，开始执行前的检查必然不过，只说前者。
  const previousUnknown = blockers.some(block => block.code === 'PREVIOUS_RESULT_UNKNOWN');
  const reasons = [...new Set(blockers.filter(block => !(previousUnknown && block.code === 'QUEUE_START_CHECK_FAILED'))
    .map(block => explanations[block.code] ?? '执行环境需要恢复检查'))];
  if (needsReview && options.interrupted) {
    const cause = options.interrupted;
    const choose = cause.buttons ? `可以点「${larkReplayLabels.continue_in_place}」让 Agent 接着做；确认再做一遍不会重复造成影响，可以点「${larkReplayLabels.replay_turn}」；不需要了就点「${larkReplayLabels.abandon_turn}」。` : '';
    return { blocked, label: '结果未知', relaunch: false, continueInPlace: false,
      markdown: `**结果未知**\n\n${larkInterruptionSummary(cause.code, cause.agent)}${larkHeldReason(cause)}${choose}\n\n发送 \`/status\` 查看最新状态。` };
  }
  const stall = status === 'queued' && !blocked && recovery?.activeTaskId ? await runtime.getTurnStall?.(sessionId).catch(() => undefined) : undefined;
  const stalled = stall !== undefined && stall.taskId === recovery?.activeTaskId;
  const label = needsReview ? '需要核对' : blocked ? '排队受阻' : stalled ? '可能卡住' : resolvedUnknown ? '已核对，结果未确认' : '排队中';
  const relaunch = options.relaunch === true && (blocked || stalled) && ['queued', 'reconcile_required', 'legacy_unresolved'].includes(status);
  // 排在结果未知那一轮后面：可以把那一轮按没做完处理，这条接着在原对话里执行。
  const continueInPlace = options.continueInPlace === true && status === 'queued' && blockers.some(block => block.code === 'PREVIOUS_RESULT_UNKNOWN');
  const continueHint = continueInPlace ? `也可以点「${larkReplayLabels.continue_in_place}」：上一轮按没做完处理，这条消息接着在原对话里执行。` : '';
  const relaunchHint = !relaunch ? '' : status === 'queued'
    ? `可以点「${larkRelaunchLabels.run_in_new_session}」：取消这条排队请求，在本话题的新会话里执行原文，之后本话题的消息也进入新会话。`
    : `可以点「${larkRelaunchLabels.rerun_in_new_session}」在新会话里重新执行原请求。原执行结果未确认，重新执行可能把已经做过的操作再做一次。`;
  // 升级排空期间新消息照常入队、暂不开始：写明会自动执行，免得成员以为卡住了反复重发。
  const held = status === 'queued' && runtime.isQueueHeld?.() === true;
  const detail = blocked
    ? `${reasons.join('；') || '这一轮还不确定是否做完'}，为避免重复执行，不会自动开始。${relaunchHint}${continueHint}${larkRecoveryRetainedNote(options.webBaseUrl)}`
    : stalled ? `前面正在执行的那一轮长时间没有新的输出${stall.cpu === 'inactive' ? '，进程也没有在占用 CPU' : ''}，可能卡住了；Dutydeck 不会自动中断它。${relaunchHint}也可以在正在执行的那张卡上点「中断」。`
    : resolvedUnknown ? '这一轮已按不确定是否做完处理，不会自动重做；可以直接发新消息继续。'
    : held ? '服务正在升级，完成后会自动执行，无需重发。'
    : queuedAhead && queuedAhead > 0 ? `正在排队，前面还有 ${queuedAhead} 个任务…`
    // 紧排在执行中那一轮后面：这条不会传给那一轮，要插队得用卡上的按钮或 /steer。
    : recovery?.activeTaskId ? '要等当前这一轮结束才会处理，不会传给它。' : '已进入执行队列，等待 Agent 开始。';
  const action = resolvedUnknown && !blocked ? '发送 `/status` 查看最新状态。' : status === 'queued' ? '此请求尚未执行，可点击取消，或回原话题发送 `/cancel`；发送 `/status` 查看最新状态。'
    : '发送 `/status` 查看最新状态。';
  return { blocked, stalled, label, relaunch, continueInPlace, markdown: `**${label}**\n\n${detail}\n\n${action}` };
}

/** One durable exception notice per accepted task/turn, independent of business-final delivery. */
export async function notifyLarkTaskRecovery(input: {
  service: LarkCardService; store?: ConfigRepository; log: { warn: (...args: any[]) => void };
  appId: string; sessionId: string; taskId: string; turn?: number; target: DeliveryTarget;
  recovery: Pick<Awaited<ReturnType<typeof describeLarkTaskRecovery>>, 'blocked' | 'label' | 'markdown'>;
  /** @ 发起人的卡内标签（见 notify-tier）；和正文一起在第一次落库时冻结，重放不因配置变化而改变内容。 */
  mention?: string;
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
      const record = JSON.stringify({ target: input.target, markdown: input.recovery.markdown, label: input.recovery.label, ...(input.mention ? { mention: input.mention } : {}) });
      await store.compareAndSet!(recordKey, saved, record);
      saved = await store.get(recordKey);
    }
    if (!saved) throw new Error('Recovery notification record was not saved');
    const record = JSON.parse(saved) as { target: DeliveryTarget; markdown: string; label: string; mention?: string };
    const sent = await sendLarkResult(input.service, { ...record.target, allowReplyFallback: false }, {
      taskId: input.taskId, taskName: '任务恢复提醒', sessionId: input.sessionId, turn: input.turn,
      state: 'reconcile_required', statusLabel: record.label, readOnly: true,
      capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false },
      elements: [...(record.mention ? [{ tag: 'markdown', element_id: 'group_mention', content: record.mention }] : []),
        { tag: 'markdown', element_id: 'task_recovery_notice', content: record.markdown }],
      idempotencyKey: key
    }, input.log, store);
    return { messageId: sent.messageId, fingerprint: createHash('sha256').update(saved).digest('hex') };
  });
}

/** 结果未知提醒卡的存档键：每次执行（或每次插话）一张，同一次执行不论对账跑多少遍、重启多少次都只发一张。 */
export const larkUnknownTaskNoticeKey = (appId: string, sessionId: string, taskId: string, target: string) =>
  `unknown_${createHash('sha256').update(JSON.stringify([appId, sessionId, taskId, target])).digest('hex').slice(0, 40)}`;
export const larkUnknownTaskNoticeRecordKey = (key: string) => `lark.unknown_task.${key}`;
export type LarkUnknownTaskNotice = { target: DeliveryTarget; markdown: string; messageId?: string; mention?: string; sentAt?: number; urgentAt?: string };

/** 提醒卡正文：已知事实、能做什么、谁能做。按钮与「查看详情」由卡片渲染。 */
/** 插话投递结果未知时的回执：指向随后发到原话题的结果未知提醒卡（notifyLarkUnknownTask）和 Web 任务详情。 */
export const larkSteeringUnknownNote = `这条指令可能已送达，也可能没有，不会自动重发。请在随后发出的「结果未知」提醒卡上选择${unknownTaskActionLabels.retry}、${unknownTaskActionLabels.completed}或${unknownTaskActionLabels.failed}，也可以在 Web 任务详情里处理。`;

export const larkUnknownTaskMarkdown = (facts: UnknownTaskFacts, hasDetail: boolean) => [
  '**这一轮的结果未知，需要你决定怎么处理**',
  unknownTaskFactLines(facts).map(line => `- ${line}`).join('\n'),
  `为避免重复执行，Dutydeck 不会自动重发。${hasDetail ? '可以先点「查看详情」看执行现场，再选择：' : '可以选择：'}`,
  `- 「${unknownTaskActionLabels.retry}」：${unknownTaskRetryWarning}需要再点一次确认。`,
  `- 「${unknownTaskActionLabels.completed}」「${unknownTaskActionLabels.failed}」：人工结算这一轮，不再重发。`,
  '本轮发起人和管理员可以操作。'
].join('\n\n');

/**
 * 结果未知时在原会话发一张带按钮的提醒卡，每次执行只发一次（larkUnknownTaskNoticeKey）。
 * 第一次落库的目的地与正文冻结下来：重启后重放用同一个幂等键和同一份内容，送达回执（sendLarkResult 的 delivered 记录）挡住重复发送。
 * 返回提醒卡的消息 ID，回调端据此确认点击来自这张卡。
 */
export async function notifyLarkUnknownTask(input: {
  service: LarkCardService; store?: ConfigRepository; log: { warn: (...args: any[]) => void };
  appId: string; sessionId: string; runtimeTaskId: string; facts: UnknownTaskFacts;
  /** 原请求的飞书消息 ID 与轮次：按钮回调靠它们找回卡片映射。 */
  messageTaskId: string; turn?: number; taskName: string; agentName?: string;
  target: DeliveryTarget; webBaseUrl?: string; detailLogin?: boolean;
  /** @ 发起人的卡内标签（见 notify-tier）；随正文一起冻结。 */
  mention?: string;
}) {
  const target = input.facts.target;
  if (!input.facts.actionable || !target) return undefined;
  if (!input.store?.compareAndSet) throw new Error('Unknown-task notification requires persistent CAS');
  const store = input.store;
  const key = larkUnknownTaskNoticeKey(input.appId, input.sessionId, input.runtimeTaskId, target);
  const recordKey = larkUnknownTaskNoticeRecordKey(key);
  return withExplicitFinalLock(store, key, async () => {
    let saved = await store.get(recordKey);
    if (!saved) {
      const record: LarkUnknownTaskNotice = { target: input.target, markdown: larkUnknownTaskMarkdown(input.facts, Boolean(input.webBaseUrl)), ...(input.mention ? { mention: input.mention } : {}) };
      await store.compareAndSet!(recordKey, saved, JSON.stringify(record));
      saved = await store.get(recordKey);
    }
    if (!saved) throw new Error('Unknown-task notification record was not saved');
    const record = JSON.parse(saved) as LarkUnknownTaskNotice;
    if (record.messageId) return record.messageId;
    const webBaseUrl = input.webBaseUrl?.trim().replace(/\/$/, '');
    const sent = await sendLarkResult(input.service, { ...record.target, allowReplyFallback: false }, {
      taskId: input.messageTaskId, taskName: input.taskName, sessionId: input.sessionId, turn: input.turn,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      state: 'reconcile_required', statusLabel: '结果未知',
      capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false, unknownTaskTarget: target,
        ...(webBaseUrl ? { webUrl: `${webBaseUrl}/sessions/${encodeURIComponent(input.sessionId)}` } : {}), ...(input.detailLogin && webBaseUrl ? { detailLogin: true } : {}) },
      ...(webBaseUrl ? { webBaseUrl } : {}),
      elements: [...(record.mention ? [{ tag: 'markdown', element_id: 'group_mention', content: record.mention }] : []),
        { tag: 'markdown', element_id: 'unknown_task_notice', content: record.markdown }],
      idempotencyKey: key
    }, input.log, store);
    await store.compareAndSet!(recordKey, saved, JSON.stringify({ ...record, messageId: sent.messageId, sentAt: Date.now() }));
    return sent.messageId;
  });
}

/**
 * 结果未知提醒卡挂太久仍没人处理时，按已有加急规则加急发起人一次（阈值、免打扰、频控都在 manager 里）。
 * 阈值从提醒卡发出的时刻（sentAt）起算；升级前发出、没有 sentAt 的卡从第一次看到起算。对账每轮都会走到这里，urgentAt 落库后不再重复。
 */
export async function urgeLarkUnknownTask(input: {
  store: ConfigRepository; manager: Pick<LarkUrgentManager, 'urgeNotice'>;
  appId: string; sessionId: string; runtimeTaskId: string; target: string; chatId: string; targetUserId: string; now?: number;
}) {
  const now = input.now ?? Date.now();
  const recordKey = larkUnknownTaskNoticeRecordKey(larkUnknownTaskNoticeKey(input.appId, input.sessionId, input.runtimeTaskId, input.target));
  const saved = await input.store.get(recordKey);
  const record = saved ? JSON.parse(saved) as LarkUnknownTaskNotice : undefined;
  if (!saved || !record?.messageId) return undefined;
  if (record.sentAt === undefined) {
    await input.store.compareAndSet!(recordKey, saved, JSON.stringify({ ...record, sentAt: now }));
    return undefined;
  }
  const outcome = await input.manager.urgeNotice({ id: recordKey, chatId: input.chatId, messageId: record.messageId, targetUserId: input.targetUserId,
    since: record.sentAt, ...(record.urgentAt ? { urgentAt: record.urgentAt } : {}) }, 'unknown_task_notice', now);
  if (outcome === 'urged') await input.store.compareAndSet!(recordKey, saved, JSON.stringify({ ...record, urgentAt: new Date(now).toISOString() }));
  return outcome;
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
