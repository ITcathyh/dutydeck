import type { ChannelMappingRepository, TaskRecord } from '@dockmux/shared';
import { defaultLarkTraceLimit, type StoredLarkConfig } from './config.js';
import { boundLarkCardElements, type LarkCardService } from './service.js';
import {
  eventsForRuntimeTask,
  hasUnresolvedToolCalls,
  isLarkCardContentRejected,
  isLarkMessageRateLimit,
  isLarkMessageUnupdatable,
  larkRateLimitBackoffMs,
  patchRejectedCardDelta,
  renderLarkCardElements,
  terminalTaskStates,
  type LarkCardElement
} from './card-renderer.js';
import type { ListenerLog, LarkRuntime } from './listener.js';
import type { PersistedLarkCardTask } from './coordinator.js';

// 进程重启后的卡片终态对账（从 listener.ts 的 LarkMessageCoordinator.performReconcile 拆分）。
// 对账可能无法更新原 running 卡片，只能补发终态卡片；持久化真实 reply_message_id 和话题标记，
// 让进程重启后的终态补发仍回到原话题。

const persistedCardTask = (value?: string | null): PersistedLarkCardTask | undefined => {
  if (!value) return;
  try {
    const parsed = JSON.parse(value) as Partial<PersistedLarkCardTask>;
    if (!parsed.app_id || !parsed.chat_id || !parsed.card_message_id || !parsed.task_name || !parsed.state || !Number.isFinite(parsed.started_at)) return;
    return parsed as PersistedLarkCardTask;
  } catch { return; }
};

// 旧 root_message_id 仅在确实是 om_* 消息 ID 时兼容；omt_* 不能传给回复接口。
async function sendPersistedTaskCard(
  service: Pick<LarkCardService, 'send' | 'reply'>,
  persisted: Pick<PersistedLarkCardTask, 'chat_id' | 'reply_message_id' | 'reply_in_thread' | 'root_message_id'>,
  input: Omit<Parameters<LarkCardService['send']>[0], 'chatId'>,
  log?: { warn: (...args: any[]) => void }
) {
  const replyMessageId = persisted.reply_message_id?.trim()
    || (persisted.root_message_id?.trim().startsWith('om_') ? persisted.root_message_id.trim() : undefined);
  if (replyMessageId && typeof service.reply === 'function') {
    try {
      return await service.reply({ messageId: replyMessageId, ...(persisted.reply_in_thread ? { replyInThread: true } : {}), ...input });
    } catch (error) {
      // The original message may have been deleted while Dockmux was down.
      // Keep reconciliation deliverable by falling back to a top-level card.
      log?.warn({ error, messageId: replyMessageId, chatId: persisted.chat_id }, '恢复卡片回复失败，回退为群内发送');
    }
  }
  return await service.send({ chatId: persisted.chat_id, ...input });
}

export async function performLarkCardReconcile(input: {
  runtime: LarkRuntime;
  service: LarkCardService;
  cardMappings: ChannelMappingRepository;
  log: ListenerLog;
  config: StoredLarkConfig;
  channel: string;
}): Promise<number> {
  const { runtime, service, cardMappings, log, config, channel } = input;
  if (!runtime.getTasks || !runtime.getEvents) return 0;
  const mappings = await cardMappings.list(channel);
  let unresolved = 0;
  for (const mapping of mappings) {
    const persisted = persistedCardTask(mapping.extra);
    if (!persisted || terminalTaskStates.has(persisted.state)) continue;
    let runtimeTasks: TaskRecord[];
    try { runtimeTasks = await runtime.getTasks(mapping.sessionId); }
    catch (error) { unresolved++; log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '读取待补偿飞书任务失败'); continue; }
    const runtimeTask = (persisted.runtime_task_id ? runtimeTasks.find(item => item.id === persisted.runtime_task_id) : undefined)
      ?? [...runtimeTasks].reverse().find(item => item.prompt === persisted.prompt && Date.parse(item.createdAt) >= persisted.started_at - 5_000);
    if (!runtimeTask || !terminalTaskStates.has(runtimeTask.status)) { unresolved++; continue; }
    let state: 'completed' | 'failed' | 'interrupted' = runtimeTask.status === 'completed'
      ? 'completed'
      : runtimeTask.status === 'failed' ? 'failed' : 'interrupted';
    const recentLimit = Math.max((config.traceLimit ?? defaultLarkTraceLimit) * 30, 500);
    const sessionEvents = await (runtime.getRecentEvents?.(mapping.sessionId, recentLimit) ?? runtime.getEvents!(mapping.sessionId)).catch(() => []);
    const events = eventsForRuntimeTask(sessionEvents, runtimeTask.id);
    if (state === 'completed' && hasUnresolvedToolCalls(events)) state = 'failed';
    const completed = state === 'completed';
    const elapsedSeconds = Math.max(0, (Date.parse(runtimeTask.updatedAt) - persisted.started_at) / 1_000);
    let updated = false;
    let lastError: unknown;
    let contentRejected = false;
    const currentElements = boundLarkCardElements(renderLarkCardElements(events, config, completed));
    let deliveredElements = currentElements;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await service.update({
          messageId: persisted.card_message_id,
          state,
          taskId: mapping.externalId,
          taskName: persisted.task_name,
          elapsedSeconds,
          sessionId: mapping.sessionId,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements: currentElements
        });
        updated = true;
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
    if (!updated && contentRejected && Array.isArray(persisted.last_successful_elements) && persisted.last_successful_elements.length) {
      const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
      try {
        await service.update({
          messageId: persisted.card_message_id,
          state,
          taskId: mapping.externalId,
          taskName: persisted.task_name,
          elapsedSeconds,
          sessionId: mapping.sessionId,
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
    let cardMessageId = persisted.card_message_id;
    if (!updated) {
      if (!isLarkMessageUnupdatable(lastError)) {
        log.warn({ error: lastError, messageId: persisted.card_message_id }, '飞书原卡暂时更新失败，保留原卡等待下次对账');
        unresolved++;
        continue;
      }
      try {
        const replacementElements = contentRejected
          ? patchRejectedCardDelta(persisted.last_successful_elements, currentElements)
          : boundLarkCardElements(renderLarkCardElements(events, config, completed, true));
        const replacement = await sendPersistedTaskCard(service, persisted, {
          state,
          taskId: mapping.externalId,
          taskName: persisted.task_name,
          elapsedSeconds,
          sessionId: mapping.sessionId,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements: replacementElements,
          idempotencyKey: `reconcile_${persisted.card_message_id}_${state}`.slice(0, 50)
        }, log);
        cardMessageId = replacement.messageId;
        deliveredElements = replacementElements;
      } catch (error) {
        if (isLarkCardContentRejected(error)) {
          try {
            const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
            const minimal = await sendPersistedTaskCard(service, persisted, {
              state,
              taskId: mapping.externalId,
              taskName: persisted.task_name,
              elapsedSeconds,
              sessionId: mapping.sessionId,
              ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
              elements: patchedElements,
              idempotencyKey: `reconcile_safe_${persisted.card_message_id}_${state}`.slice(0, 50)
            }, log);
            cardMessageId = minimal.messageId;
            deliveredElements = patchedElements;
            log.warn({ rejectedMessageId: persisted.card_message_id, replacementMessageId: cardMessageId, upstreamCode: error.details?.upstreamCode }, '飞书补发终态卡片内容被拒绝，已降级为最小安全卡片');
          } catch (fallbackError) {
            log.error({ error: fallbackError, contentError: error, updateError: lastError, messageId: persisted.card_message_id }, '飞书终态对账最小卡片补偿失败');
            unresolved++;
            continue;
          }
        } else {
          log.error({ error, updateError: lastError, messageId: persisted.card_message_id }, '飞书终态对账补偿失败');
          unresolved++;
          continue;
        }
      }
    }
    await cardMappings.save({
      ...mapping,
      extra: JSON.stringify({ ...persisted, card_message_id: cardMessageId, runtime_task_id: runtimeTask.id, state, last_successful_elements: deliveredElements })
    });
    log.info({ messageId: persisted.card_message_id, replacementMessageId: cardMessageId === persisted.card_message_id ? undefined : cardMessageId, state }, '飞书卡片终态对账完成');
  }
  return unresolved;
}
