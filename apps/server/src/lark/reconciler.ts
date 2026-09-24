import { completeExplicitFinal, explicitFinalContext, hasExplicitFinal, withExplicitFinalLock } from './explicit-final.js';
import { describeLarkTaskRecovery, notifyLarkTaskRecovery, verifiedLarkRecoveryOutput } from './task-recovery.js';
import type { ChannelMapping, ChannelMappingRepository, ConfigRepository, TaskRecord } from '@dutydeck/shared';
import { defaultLarkTraceLimit, larkPermissionMode, type StoredLarkConfig } from './config.js';
import { boundLarkCardElements, type LarkCardInput, type LarkCardService } from './service.js';
import {
  loadLarkTaskEvents,
  hasUnresolvedToolCalls,
  isLarkCardContentRejected,
  isLarkMessageRateLimit,
  isLarkMessageUnupdatable,
  larkRateLimitBackoffMs,
  patchRejectedCardDelta,
  renderLarkProcessElements,
  renderLarkResultElements,
  terminalTaskStates
} from './card-renderer.js';
import { deliverLarkCompletionReaction, larkResultKey, larkSilentResultAnchor, sendLarkResult } from './result-delivery.js';
import { RECOVERY_TRACKING_NOTE } from './recovery-notes.js';
import { senderGroupMention } from './card-mentions.js';
import type { ListenerLog, LarkRuntime } from './listener.js';
import type { PersistedLarkCardTask } from './coordinator.js';

// 进程重启后分别对账执行过程卡的终态和独立结果消息。

const persistedCardTask = (value?: string | null): PersistedLarkCardTask | undefined => {
  if (!value) return;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedLarkCardTask>;
    // card_message_id 可以缺席：中间进展静默的那些轮次根本没发过程卡，
    // 但结果仍然要靠对账补发，映射不能被当成损坏记录丢掉。
    if (!parsed.app_id || !parsed.chat_id || !parsed.task_name || !parsed.state || !Number.isFinite(parsed.started_at)) return;
    return parsed as PersistedLarkCardTask;
  } catch { return; }
};

export async function performLarkCardReconcile(input: {
  runtime: LarkRuntime;
  service: LarkCardService;
  cardMappings: ChannelMappingRepository;
  log: ListenerLog;
  config: StoredLarkConfig;
  channel: string;
  deliveryStore?: ConfigRepository;
  resultElements?: (mapping: ChannelMapping, saved: PersistedLarkCardTask, cardId: string) => Promise<Array<Record<string, any>>>;
  terminalDecoration?: (mapping: ChannelMapping, saved: PersistedLarkCardTask, config: StoredLarkConfig) => Promise<{ elements: Array<Record<string, any>>; cardInput: LarkCardInput }>;
  /** 按记录所属会话解析生效配置（群级呈现覆盖）。缺省时全部按 Bot 级配置补发。 */
  resolveConfig?: (saved: PersistedLarkCardTask) => Promise<StoredLarkConfig>;
}): Promise<number> {
  const { runtime, service, cardMappings, log, config, channel } = input;
  if (!runtime.getTasks || !runtime.getEvents) return 0;
  let agentName = config.defaultAgentId ?? 'Dutydeck';
  try { agentName = (await runtime.listAgents?.())?.find(agent => agent.id === config.defaultAgentId)?.name ?? agentName; }
  catch (error) { log.warn({ error, agentId: config.defaultAgentId }, '读取 Agent 展示名失败，使用 Agent ID 对账卡片'); }
  const cardContext = { agentName, ...(config.workspace ? { workspace: config.workspace } : {}) };
  const mappings = await cardMappings.list(channel);
  let unresolved = 0;
  for (const mapping of mappings) {
    try {
      const persisted = persistedCardTask(mapping.extra);
      if (!persisted) continue;
      // 呈现开关可以按群覆盖：补发方式必须按这条记录所属会话的生效配置决定。
      const effective = (await input.resolveConfig?.(persisted)) ?? config;
      const terminalPersisted = terminalTaskStates.has(persisted.state);
      const alreadyDelivered = terminalPersisted
        && ((persisted.final_delivery_state === 'delivered' && Boolean(persisted.final_message_id))
          // 只贴表情的终态没有结果消息 id，它本身就是「已交付」。
          || persisted.final_delivery_state === 'reaction');
      // 旧版单卡结果已经交付，保留历史消息，不追发。
      if (alreadyDelivered && persisted.final_message_id && persisted.final_message_id === persisted.card_message_id) continue;
      if (alreadyDelivered) {
        if (persisted.state === 'completed' && persisted.final_message_id && input.resultElements) await input.resultElements(mapping, persisted, persisted.final_message_id);
        // 没有过程卡就没有可冻结的对象，直接收敛。
        if (persisted.progress_frozen || !persisted.card_message_id) continue;
        const legacyElements = persisted.last_successful_elements?.length ? persisted.last_successful_elements : undefined;
        try {
          await service.update({
            ...cardContext,
            cardKind: 'process',
            messageId: persisted.card_message_id,
            permissionMode: larkPermissionMode(config),
            state: persisted.state as 'completed' | 'failed' | 'interrupted',
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds: Math.max(0, (Date.now() - persisted.started_at) / 1_000),
            sessionId: mapping.sessionId,
            readOnly: true,
            turn: persisted.turn,
            // 结果早已作为另一条消息送达（只贴表情时没有这一条）。
            ...(persisted.final_delivery_state === 'delivered' ? { resultFollows: true } : {}),
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            ...(legacyElements ? { elements: legacyElements } : {})
          });
          const saved = await cardMappings.compareAndSetExtra(mapping.id, mapping.extra, JSON.stringify({ ...persisted, progress_frozen: true }));
          if (!saved) unresolved++;
        } catch (error) {
          // 过程卡已被删除或过了可更新期：它永远不可能再收敛，重试只是每轮空打一次 API。
          // 结论早已作为另一条消息送达，这里不发任何卡片，就地记为已冻结即可。
          if (isLarkMessageUnupdatable(error)) {
            const saved = await cardMappings.compareAndSetExtra(mapping.id, mapping.extra, JSON.stringify({ ...persisted, progress_frozen: true }));
            if (saved) {
              log.info({ externalId: mapping.externalId, messageId: persisted.card_message_id }, '执行过程卡已不可更新，就地收敛不再重试');
            } else {
              unresolved++;
            }
            continue;
          }
          unresolved++;
          log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '执行过程卡收敛失败，稍后重试');
        }
        continue;
      }
      let runtimeTasks: TaskRecord[];
      try { runtimeTasks = await runtime.getTasks(mapping.sessionId); }
      catch (error) { unresolved++; log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '读取待补偿飞书任务失败'); continue; }
      const runtimeTask = (persisted.runtime_task_id ? runtimeTasks.find(item => item.id === persisted.runtime_task_id) : undefined)
        ?? [...runtimeTasks].reverse().find(item => item.prompt === persisted.prompt && Date.parse(item.createdAt) >= persisted.started_at - 5_000);
      if (!runtimeTask) { unresolved++; continue; }
      if (!terminalTaskStates.has(runtimeTask.status)) {
        unresolved++;
        const recovery = ['queued', 'reconcile_required', 'legacy_unresolved'].includes(runtimeTask.status)
          ? await describeLarkTaskRecovery(runtime, mapping.sessionId, runtimeTask.id, runtimeTask.status) : undefined;
        const state = runtimeTask.status === 'reconcile_required' || runtimeTask.status === 'legacy_unresolved'
          ? runtimeTask.status : runtimeTask.status === 'queued' ? 'queued' : 'running';
        const canCancel = state === 'queued' && Boolean(runtime.cancelQueued && persisted.sender_open_id);
        // Repaint whenever durable recovery facts change, including older cards
        // already marked read-only. Never retain an old thinking/queued trace.
        const statusKey = JSON.stringify([state, recovery?.markdown, canCancel]);
        const notifyRecovery = () => recovery?.blocked ? notifyLarkTaskRecovery({
          service, store: input.deliveryStore, log, appId: persisted.app_id,
          sessionId: mapping.sessionId, taskId: runtimeTask.id, turn: persisted.turn, recovery,
          target: { chatId: persisted.chat_id,
            replyMessageId: persisted.reply_message_id?.trim()
              || (persisted.root_message_id?.trim().startsWith('om_') ? persisted.root_message_id.trim() : undefined),
            replyInThread: persisted.reply_in_thread }
        }) : Promise.resolve(undefined);
        if (effective.silentProgress || persisted.progress_frozen || !persisted.card_message_id) {
          await cardMappings.compareAndSetExtra(mapping.id, mapping.extra, JSON.stringify({ ...persisted, state,
            runtime_task_id: runtimeTask.id, recovery_read_only: true, recovery_status_key: statusKey }));
          await notifyRecovery();
          continue;
        }
        if (persisted.recovery_status_key !== statusKey) try {
          await service.update({
            ...cardContext, cardKind: 'process', messageId: persisted.card_message_id,
            permissionMode: larkPermissionMode(config), state,
            ...(recovery ? { statusLabel: recovery.label } : {}),
            taskId: mapping.externalId, taskName: persisted.task_name,
            elapsedSeconds: Math.max(0, (Date.now() - persisted.started_at) / 1_000),
            sessionId: mapping.sessionId, readOnly: !canCancel, turn: persisted.turn ?? 0,
            capabilities: { canCancelQueued: canCancel, canInterrupt: false, canRetry: false, canRefresh: false },
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            markdown: recovery?.markdown ?? RECOVERY_TRACKING_NOTE
          });
          await cardMappings.compareAndSetExtra(mapping.id, mapping.extra, JSON.stringify({ ...persisted, state, runtime_task_id: runtimeTask.id, recovery_read_only: !canCancel, recovery_status_key: statusKey }));
        } catch (error) {
          if (isLarkMessageUnupdatable(error)) {
            const saved = await cardMappings.compareAndSetExtra(mapping.id, mapping.extra, JSON.stringify({
              ...persisted, state, runtime_task_id: runtimeTask.id, recovery_read_only: !canCancel, recovery_status_key: statusKey, progress_frozen: true
            }));
            if (saved) {
              await notifyRecovery();
              log.info({ externalId: mapping.externalId, messageId: persisted.card_message_id }, '恢复过程卡已冻结，异常通知按原目的地交付');
            }
          } else {
            log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '恢复中的飞书卡片刷新失败');
          }
        }
        continue;
      }
      let state: 'completed' | 'failed' | 'interrupted' | 'cancelled' = runtimeTask.status === 'completed'
        ? 'completed'
        : runtimeTask.status === 'failed' ? 'failed' : runtimeTask.status === 'cancelled' ? 'cancelled' : 'interrupted';
      const recentLimit = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
      let events;
      try { events = await loadLarkTaskEvents(runtime, mapping.sessionId, runtimeTask.id, recentLimit); }
      catch (error) {
        unresolved++;
        log.warn({ error, taskId: runtimeTask.id, sessionId: mapping.sessionId, externalId: mapping.externalId }, '读取执行结果失败，等待下次对账');
        continue;
      }
      const verifiedOutput = state === 'completed'
        ? await verifiedLarkRecoveryOutput(runtime, mapping.sessionId, runtimeTask.id, events) : undefined;
      if (state === 'completed' && !verifiedOutput && hasUnresolvedToolCalls(events)) state = 'failed';
      const completed = state === 'completed';
      const elapsedSeconds = Math.max(0, (Date.parse(runtimeTask.updatedAt) - persisted.started_at) / 1_000);
      const cardMessageId = persisted.card_message_id;
      // 没有过程卡的轮次直接视为「过程已收敛」，只补结果这条腿。
      let updated = Boolean(persisted.progress_frozen) || !cardMessageId;
      let lastError: unknown;
      let contentRejected = false;
      const currentElements = boundLarkCardElements(renderLarkProcessElements(events, config, true));
      // 回执上的「结果见下条」：只贴表情的模式下这次对账不会补发结果消息。
      const resultFollows = completed && effective.completionReactionOnly !== true;
      let deliveredElements = persisted.last_successful_elements;
      for (let attempt = 1; !updated && cardMessageId && attempt <= 3; attempt++) {
        try {
          await service.update({
            ...cardContext,
            cardKind: 'process',
            messageId: cardMessageId,
            permissionMode: larkPermissionMode(config),
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            readOnly: true,
            turn: persisted.turn,
            ...(resultFollows ? { resultFollows: true } : {}),
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: currentElements
          });
          updated = true;
          deliveredElements = currentElements;
          break;
        } catch (error) {
          lastError = error;
          if (isLarkCardContentRejected(error)) { contentRejected = true; break; }
          if (isLarkMessageUnupdatable(error)) break;
          if (attempt < 3) {
            const delay = isLarkMessageRateLimit(error) ? larkRateLimitBackoffMs(attempt) : attempt * 300;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      // 内容被拒绝只允许原地降级，不允许因此另发一条消息。
      if (!updated && cardMessageId && contentRejected && Array.isArray(persisted.last_successful_elements) && persisted.last_successful_elements.length) {
        const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
        try {
          await service.update({
            ...cardContext,
            cardKind: 'process',
            messageId: cardMessageId,
            permissionMode: larkPermissionMode(config),
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            readOnly: true,
            turn: persisted.turn,
            ...(resultFollows ? { resultFollows: true } : {}),
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: patchedElements
          });
          updated = true;
          deliveredElements = patchedElements;
          lastError = undefined;
          log.warn({ messageId: persisted.card_message_id, state }, '飞书终态卡片增量被拒绝，已保留上次成功内容并原地修补');
        } catch (error) {
          lastError = error;
        }
      }
      if (!updated && isLarkMessageUnupdatable(lastError)) updated = true;
      await withExplicitFinalLock(input.deliveryStore, runtimeTask.id, async () => {
        const finalContext = completed ? explicitFinalContext(mapping, persisted, runtimeTask.currentAttemptId) : undefined;
        const explicit = await hasExplicitFinal(input.deliveryStore, finalContext);
        let finalCardInput: LarkCardInput | undefined;
        let finalMessageId: string | undefined;
        let finalAttachmentMessageId: string | undefined;
        let finalElements: Array<Record<string, any>> | undefined;
        let reactionDelivered = false;
        let resultCallbackFailed = false;
        try {
          // 完成时只贴表情：重启补发同样不发结果卡，只补那一枚表情。
          // 失败/中断/取消照旧补发结果卡——重启不是把失败藏起来的理由。
          if (!explicit && completed && effective.completionReactionOnly === true) {
            reactionDelivered = await deliverLarkCompletionReaction(
              service, { appId: persisted.app_id, messageId: mapping.externalId }, log, input.deliveryStore);
          } else {
          // P0-4：重启对账补发的结果/失败/中断卡与实时链路同口径 @ 发起人；idempotencyKey
          // 保证消息不重发，@ 也不会重复。开关按群覆盖后的生效配置取值（与实时链路一致），
          // 群里关掉 @ 时本元素不存在。
          // 发起人是机器人时同样不 @ 回去：刷屏事故里最容易触发的恰好是重启对账这条路。
          const mention = senderGroupMention(effective.groupCardMention, {
            chatType: persisted.chat_type, senderOpenId: persisted.sender_open_id, senderType: persisted.sender_type });
          const decoration = await input.terminalDecoration?.(mapping, { ...persisted, runtime_task_id: runtimeTask.id, state }, effective);
          const elements = [
            ...(explicit ? [] : renderLarkResultElements(verifiedOutput ? [verifiedOutput] : events)),
            ...(decoration?.elements ?? []),
            ...(completed && input.resultElements ? await input.resultElements(mapping, persisted, '') : []),
            ...(mention ? [{ tag: 'markdown', element_id: 'group_mention', content: mention }] : [])];
          finalCardInput = {
            ...cardContext, permissionMode: larkPermissionMode(config), state, cardKind: 'result',
            taskId: mapping.externalId, taskName: persisted.task_name,
            elapsedSeconds, sessionId: mapping.sessionId, turn: persisted.turn, readOnly: true,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}), ...decoration?.cardInput
          };
          const result = await completeExplicitFinal(input.deliveryStore, service, finalContext, finalCardInput, elements) ?? await sendLarkResult(service, {
            chatId: persisted.chat_id,
            replyMessageId: persisted.reply_message_id?.trim()
              || (persisted.root_message_id?.trim().startsWith('om_') ? persisted.root_message_id.trim() : undefined),
            replyInThread: persisted.reply_in_thread
          }, { ...finalCardInput, elements, idempotencyKey: larkResultKey(cardMessageId ?? larkSilentResultAnchor(mapping.externalId, persisted.turn)) }, log, input.deliveryStore);
          finalAttachmentMessageId = result.attachmentMessageId;
          finalMessageId = result.messageId;
          finalElements = result.elements;
          if (completed && input.resultElements) {
            try {
              await input.resultElements(mapping, { ...persisted, final_attachment_message_id: finalAttachmentMessageId }, finalMessageId);
            } catch (callbackError) {
              resultCallbackFailed = true;
              log.warn({ error: callbackError, messageId: persisted.card_message_id, finalMessageId, sessionId: mapping.sessionId, externalId: mapping.externalId }, '执行结果回调写入失败，稍后重试');
            }
          }
          }
        } catch (error) {
          log.warn({ error, messageId: persisted.card_message_id, sessionId: mapping.sessionId, externalId: mapping.externalId }, '执行结果交付待下次对账重试');
        }
        if (!updated || (!finalMessageId && !reactionDelivered) || resultCallbackFailed) unresolved++;
        // 原子 CAS：只有 mapping.extra 仍是本轮读到的旧快照时才写回，避免在 PATCH/结果发送
        // 在途期间新一轮 turn 已 save 后，旧快照把新 turn/新卡覆盖回旧值并误冻结。
        const casSaved = await cardMappings.compareAndSetExtra(mapping.id, mapping.extra, JSON.stringify({
          ...persisted, runtime_task_id: runtimeTask.id, state,
          progress_frozen: updated,
          ...(finalMessageId
            ? { final_message_id: finalMessageId, final_attachment_message_id: finalAttachmentMessageId, final_delivery_state: 'delivered', final_elements: finalElements, final_card_input: finalCardInput }
            : reactionDelivered ? { final_delivery_state: 'reaction' } : {}),
          last_successful_elements: deliveredElements
        }));
        if (casSaved) {
          log.info({ messageId: persisted.card_message_id, finalMessageId, reactionDelivered, state, progressFrozen: updated }, '飞书过程与结果消息对账完成');
        } else {
          // CAS 失败说明映射已被更新的一轮/实时链路写过：不覆盖，多跑一轮继续跟踪。
          unresolved++;
          log.info({ externalId: mapping.externalId, messageId: persisted.card_message_id }, '飞书卡片映射在对账期间已被更新，放弃旧快照写回并继续跟踪');
        }
      });
    } catch (error) {
      unresolved++;
      log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '对账单条卡片映射处理异常，稍后重试');
    }
  }
  return unresolved;
}
