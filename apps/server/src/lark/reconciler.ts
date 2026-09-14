import type { ChannelMapping, ChannelMappingRepository, TaskRecord } from '@dutydeck/shared';
import { defaultLarkTraceLimit, larkPermissionMode, type StoredLarkConfig } from './config.js';
import { boundLarkCardElements, type LarkCardService } from './service.js';
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
import { larkResultKey, sendLarkResult } from './result-delivery.js';
import { RECOVERY_TRACKING_NOTE } from './recovery-notes.js';
import { isGroupChat, renderGroupMention } from './card-mentions.js';
import type { ListenerLog, LarkRuntime } from './listener.js';
import type { PersistedLarkCardTask } from './coordinator.js';

// 进程重启后分别对账执行过程卡的终态和独立结果消息。

const persistedCardTask = (value?: string | null): PersistedLarkCardTask | undefined => {
  if (!value) return;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedLarkCardTask>;
    if (!parsed.app_id || !parsed.chat_id || !parsed.card_message_id || !parsed.task_name || !parsed.state || !Number.isFinite(parsed.started_at)) return;
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
  resultElements?: (mapping: ChannelMapping, saved: PersistedLarkCardTask, cardId: string) => Promise<Array<Record<string, any>>>;
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
      const terminalPersisted = terminalTaskStates.has(persisted.state);
      const alreadyDelivered = terminalPersisted
        && persisted.final_delivery_state === 'delivered'
        && Boolean(persisted.final_message_id);
      // 旧版单卡结果已经交付，保留历史消息，不追发。
      if (alreadyDelivered && persisted.final_message_id === persisted.card_message_id) continue;
      if (alreadyDelivered) {
        if (persisted.state === 'completed' && input.resultElements) await input.resultElements(mapping, persisted, persisted.final_message_id!);
        if (persisted.progress_frozen) continue;
        const legacyElements = persisted.last_successful_elements?.length ? persisted.last_successful_elements : undefined;
        try {
          await service.update({
            ...cardContext,
            messageId: persisted.card_message_id,
            permissionMode: larkPermissionMode(config),
            state: persisted.state as 'completed' | 'failed' | 'interrupted',
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds: Math.max(0, (Date.now() - persisted.started_at) / 1_000),
            sessionId: mapping.sessionId,
            readOnly: true,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            ...(legacyElements ? { elements: legacyElements } : {})
          });
          await cardMappings.save({ ...mapping, extra: JSON.stringify({ ...persisted, progress_frozen: true }) });
        } catch (error) {
          // 过程卡已被删除或过了可更新期：它永远不可能再收敛，重试只是每轮空打一次 API。
          // 结论早已作为另一条消息送达，这里不发任何卡片，就地记为已冻结即可。
          if (isLarkMessageUnupdatable(error)) {
            await cardMappings.save({ ...mapping, extra: JSON.stringify({ ...persisted, progress_frozen: true }) });
            log.info({ externalId: mapping.externalId, messageId: persisted.card_message_id }, '执行过程卡已不可更新，就地收敛不再重试');
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
        // The coordinator's in-memory action map is intentionally not restored.
        // Remove stale cancel/interrupt actions immediately while reconciliation
        // keeps polling the durable Runtime task to its terminal state.
        if (!persisted.recovery_read_only) try {
          await service.update({
            ...cardContext,
            messageId: persisted.card_message_id,
            permissionMode: larkPermissionMode(config),
            state: runtimeTask.status === 'queued' ? 'queued' : 'running',
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds: Math.max(0, (Date.now() - persisted.started_at) / 1_000),
            sessionId: mapping.sessionId,
            readOnly: true,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            ...(Array.isArray(persisted.last_successful_elements) && persisted.last_successful_elements.length
              ? { elements: persisted.last_successful_elements }
              : { markdown: RECOVERY_TRACKING_NOTE })
          });
          await cardMappings.save({
            ...mapping,
            extra: JSON.stringify({ ...persisted, runtime_task_id: runtimeTask.id, recovery_read_only: true })
          });
        } catch (error) {
          log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '恢复中的飞书卡片切换只读失败');
        }
        unresolved++;
        continue;
      }
      let state: 'completed' | 'failed' | 'interrupted' = runtimeTask.status === 'completed'
        ? 'completed'
        : runtimeTask.status === 'failed' ? 'failed' : 'interrupted';
      const recentLimit = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
      let events;
      try { events = await loadLarkTaskEvents(runtime, mapping.sessionId, runtimeTask.id, recentLimit); }
      catch (error) {
        unresolved++;
        log.warn({ error, taskId: runtimeTask.id, sessionId: mapping.sessionId, externalId: mapping.externalId }, '读取执行结果失败，等待下次对账');
        continue;
      }
      if (state === 'completed' && hasUnresolvedToolCalls(events)) state = 'failed';
      const completed = state === 'completed';
      const elapsedSeconds = Math.max(0, (Date.parse(runtimeTask.updatedAt) - persisted.started_at) / 1_000);
      let updated = Boolean(persisted.progress_frozen);
      let lastError: unknown;
      let contentRejected = false;
      const currentElements = boundLarkCardElements(renderLarkProcessElements(events, config, true));
      let deliveredElements = persisted.last_successful_elements;
      for (let attempt = 1; !updated && attempt <= 3; attempt++) {
        try {
          await service.update({
            ...cardContext,
            messageId: persisted.card_message_id,
            permissionMode: larkPermissionMode(config),
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            readOnly: true,
            ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
            elements: currentElements
          });
          updated = true;
          deliveredElements = currentElements;
          break;
        } catch (error) {
          lastError = error;
          if (isLarkCardContentRejected(error)) { contentRejected = true; break; }
          if (attempt < 3) {
            const delay = isLarkMessageRateLimit(error) ? larkRateLimitBackoffMs(attempt) : attempt * 300;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }
      // 内容被拒绝只允许原地降级，不允许因此另发一条消息。
      if (!updated && contentRejected && Array.isArray(persisted.last_successful_elements) && persisted.last_successful_elements.length) {
        const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
        try {
          await service.update({
            ...cardContext,
            messageId: persisted.card_message_id,
            permissionMode: larkPermissionMode(config),
            state,
            taskId: mapping.externalId,
            taskName: persisted.task_name,
            elapsedSeconds,
            sessionId: mapping.sessionId,
            readOnly: true,
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
      let finalMessageId: string | undefined;
      let finalElements: Array<Record<string, any>> | undefined;
      let resultCallbackFailed = false;
      try {
        // P0-4：重启对账补发的结果/失败/中断卡与实时链路同口径 @ 发起人；idempotencyKey
        // 保证消息不重发，@ 也不会重复。默认关闭时本元素不存在，卡面逐字节不变。
        const mention = config.groupCardMention === true && isGroupChat(persisted.chat_type) && persisted.sender_open_id
          ? renderGroupMention(persisted.sender_open_id)
          : undefined;
        const elements = [
          ...(mention ? [{ tag: 'markdown', element_id: 'group_mention', content: mention }] : []),
          ...renderLarkResultElements(events),
          ...(completed && input.resultElements ? await input.resultElements(mapping, persisted, '') : [])];
        const result = await sendLarkResult(service, {
          chatId: persisted.chat_id,
          replyMessageId: persisted.reply_message_id?.trim()
            || (persisted.root_message_id?.trim().startsWith('om_') ? persisted.root_message_id.trim() : undefined),
          replyInThread: persisted.reply_in_thread
        }, {
          ...cardContext, permissionMode: larkPermissionMode(config), state,
          taskId: mapping.externalId, taskName: persisted.task_name,
          elapsedSeconds, sessionId: mapping.sessionId, turn: persisted.turn, readOnly: true,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements, idempotencyKey: larkResultKey(persisted.card_message_id)
        }, log);
        finalMessageId = result.messageId;
        finalElements = result.elements;
        if (completed && input.resultElements) {
          try {
            await input.resultElements(mapping, persisted, finalMessageId);
          } catch (callbackError) {
            resultCallbackFailed = true;
            log.warn({ error: callbackError, messageId: persisted.card_message_id, finalMessageId, sessionId: mapping.sessionId, externalId: mapping.externalId }, '执行结果回调写入失败，稍后重试');
          }
        }
      } catch (error) {
        log.warn({ error, messageId: persisted.card_message_id, sessionId: mapping.sessionId, externalId: mapping.externalId }, '执行结果交付待下次对账重试');
      }
      if (!updated || !finalMessageId || resultCallbackFailed) unresolved++;
      // A newer turn or live delivery may have updated the mapping during I/O.
      const current = (await cardMappings.list(channel)).find(item => item.id === mapping.id);
      if (current?.extra !== mapping.extra) continue;
      await cardMappings.save({
        ...mapping,
        extra: JSON.stringify({
          ...persisted, runtime_task_id: runtimeTask.id, state,
          progress_frozen: updated,
          ...(finalMessageId ? { final_message_id: finalMessageId, final_delivery_state: 'delivered', final_elements: finalElements } : {}),
          last_successful_elements: deliveredElements
        })
      });
      log.info({ messageId: persisted.card_message_id, finalMessageId, state, progressFrozen: updated }, '飞书过程与结果消息对账完成');
    } catch (error) {
      unresolved++;
      log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '对账单条卡片映射处理异常，稍后重试');
    }
  }
  return unresolved;
}
