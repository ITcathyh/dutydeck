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
  larkTerminalReplacementKey,
  patchRejectedCardDelta,
  renderLarkCardElements,
  terminalTaskStates
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
  const executionInput = { permissionMode: 'full-trust' as const, ...input };
  const replyMessageId = persisted.reply_message_id?.trim()
    || (persisted.root_message_id?.trim().startsWith('om_') ? persisted.root_message_id.trim() : undefined);
  if (replyMessageId && typeof service.reply === 'function') {
    try {
      return await service.reply({ messageId: replyMessageId, ...(persisted.reply_in_thread ? { replyInThread: true } : {}), ...executionInput });
    } catch (error) {
      // The original message may have been deleted while Dockmux was down.
      // Keep reconciliation deliverable by falling back to a top-level card.
      log?.warn({ error, messageId: replyMessageId, chatId: persisted.chat_id }, '恢复卡片回复失败，回退为群内发送');
    }
  }
  return await service.send({ chatId: persisted.chat_id, ...executionInput });
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
  let agentName = config.defaultAgentId ?? 'Dockmux';
  try { agentName = (await runtime.listAgents?.())?.find(agent => agent.id === config.defaultAgentId)?.name ?? agentName; }
  catch (error) { log.warn({ error, agentId: config.defaultAgentId }, '读取 Agent 展示名失败，使用 Agent ID 对账卡片'); }
  const cardContext = { agentName, ...(config.workspace ? { workspace: config.workspace } : {}) };
  const mappings = await cardMappings.list(channel);
  let unresolved = 0;
  for (const mapping of mappings) {
    const persisted = persistedCardTask(mapping.extra);
    if (!persisted) continue;
    const terminalPersisted = terminalTaskStates.has(persisted.state);
    const alreadyDelivered = terminalPersisted
      && persisted.final_delivery_state === 'delivered'
      && Boolean(persisted.final_message_id);
    // 单卡记录已交付即完全收敛：终态就是这张卡自己。
    if (alreadyDelivered && persisted.final_message_id === persisted.card_message_id) continue;
    // 历史双消息记录：结论当年是作为**另一条**消息送达的，那条消息已经在用户的聊天里。
    // 不删、不重发、也不把结论再 PATCH 一遍到旧进度卡（那会让用户看到两份同样的结果）。
    // 唯一还欠的是把仍停在运行态的旧进度卡收敛为终态：只换状态，不加新内容。
    if (alreadyDelivered) {
      if (persisted.progress_frozen) continue;
      const legacyElements = persisted.last_successful_elements?.length ? persisted.last_successful_elements : undefined;
      try {
        await service.update({
          ...cardContext,
          messageId: persisted.card_message_id,
          permissionMode: 'full-trust',
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
        // 旧收据已被删除或过了可更新期：它永远不可能再收敛，重试只是每轮空打一次 API。
        // 结论早已作为另一条消息送达，这里不发任何卡片，就地记为已冻结即可。
        if (isLarkMessageUnupdatable(error)) {
          await cardMappings.save({ ...mapping, extra: JSON.stringify({ ...persisted, progress_frozen: true }) });
          log.info({ externalId: mapping.externalId, messageId: persisted.card_message_id }, '历史双消息记录的旧进度卡已不可更新，就地收敛不再重试');
          continue;
        }
        unresolved++;
        log.warn({ error, sessionId: mapping.sessionId, externalId: mapping.externalId }, '历史双消息记录的旧进度卡收敛失败，稍后重试');
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
          permissionMode: 'full-trust',
          state: runtimeTask.status === 'queued' ? 'queued' : 'running',
          taskId: mapping.externalId,
          taskName: persisted.task_name,
          elapsedSeconds: Math.max(0, (Date.now() - persisted.started_at) / 1_000),
          sessionId: mapping.sessionId,
          readOnly: true,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          ...(Array.isArray(persisted.last_successful_elements) && persisted.last_successful_elements.length
            ? { elements: persisted.last_successful_elements }
            : { markdown: 'Dockmux 已恢复任务状态，正在继续跟踪执行进度。' })
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
    const sessionEvents = await (runtime.getRecentEvents?.(mapping.sessionId, recentLimit) ?? runtime.getEvents!(mapping.sessionId)).catch(() => []);
    const events = eventsForRuntimeTask(sessionEvents, runtimeTask.id);
    if (state === 'completed' && hasUnresolvedToolCalls(events)) state = 'failed';
    const completed = state === 'completed';
    const elapsedSeconds = Math.max(0, (Date.parse(runtimeTask.updatedAt) - persisted.started_at) / 1_000);
    let updated = false;
    let lastError: unknown;
    let contentRejected = false;
    const chatType = persisted.chat_type ?? (persisted.reply_message_id ? 'group' : 'p2p');
    // 单卡对账：把**真实结论**写回原卡，而不是先写一张「结果已另发」的收据。
    const currentElements = boundLarkCardElements(renderLarkCardElements(events, config, completed, false, chatType));
    let deliveredElements = currentElements;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await service.update({
          ...cardContext,
          messageId: persisted.card_message_id,
          permissionMode: 'full-trust',
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
          permissionMode: 'full-trust',
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
    let cardMessageId = persisted.card_message_id;
    if (!updated) {
      // 暂时性失败：原卡还在，结论尚未送达。保持未交付，下一轮对账重试同一个 message_id。
      // 绝不因为「更新失败」就补发一条新消息——那正是要消除的第二条消息。
      if (!isLarkMessageUnupdatable(lastError)) {
        log.warn({ error: lastError, messageId: persisted.card_message_id }, '飞书原卡暂时更新失败，保留原卡等待下次对账重试');
        unresolved++;
        await cardMappings.save({
          ...mapping,
          extra: JSON.stringify({ ...persisted, runtime_task_id: runtimeTask.id, state, progress_frozen: false })
        });
        continue;
      }
      // 只有原卡确定不可更新（已删除 / 超出可更新期）才补发唯一一张终态卡，内容就是结论本身。
      try {
        const replacementElements = contentRejected
          ? patchRejectedCardDelta(persisted.last_successful_elements, currentElements)
          : currentElements;
        const replacement = await sendPersistedTaskCard(service, persisted, {
          ...cardContext,
          state,
          taskId: mapping.externalId,
          taskName: persisted.task_name,
          elapsedSeconds,
          sessionId: mapping.sessionId,
          readOnly: true,
          ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
          elements: replacementElements,
          idempotencyKey: larkTerminalReplacementKey(persisted.card_message_id, state)
        }, log);
        cardMessageId = replacement.messageId;
        deliveredElements = replacementElements;
        updated = true;
      } catch (error) {
        if (isLarkCardContentRejected(error)) {
          try {
            const patchedElements = patchRejectedCardDelta(persisted.last_successful_elements, currentElements);
            const minimal = await sendPersistedTaskCard(service, persisted, {
              ...cardContext,
              state,
              taskId: mapping.externalId,
              taskName: persisted.task_name,
              elapsedSeconds,
              sessionId: mapping.sessionId,
              readOnly: true,
              ...(config.webBaseUrl ? { webBaseUrl: config.webBaseUrl } : {}),
              elements: patchedElements,
              idempotencyKey: larkTerminalReplacementKey(persisted.card_message_id, state, true)
            }, log);
            cardMessageId = minimal.messageId;
            deliveredElements = patchedElements;
            updated = true;
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
    // 交付成功后终态就是这张卡自己：final_message_id === card_message_id。
    await cardMappings.save({
      ...mapping,
      extra: JSON.stringify({
        ...persisted,
        card_message_id: cardMessageId,
        runtime_task_id: runtimeTask.id,
        state,
        progress_frozen: true,
        final_message_id: cardMessageId,
        final_delivery_state: 'delivered',
        last_successful_elements: deliveredElements
      })
    });
    log.info({ messageId: persisted.card_message_id, replacementMessageId: cardMessageId === persisted.card_message_id ? undefined : cardMessageId, finalMessageId: cardMessageId, state }, '飞书卡片终态对账完成');
  }
  return unresolved;
}
