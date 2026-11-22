import { larkMemoryEnabled, readLarkConfigs } from '../config.js';
import { withLarkContextReadTimeout } from '../context-read-timeout.js';
import { isLarkGroupMemoryPool, larkMemoryScope, type LarkMemoryEntry, type LarkMemoryScope } from '../memory.js';
import { relevantMemoryBudget, renderLarkMemoryInjection, renderMemoryIndex } from '../memory-view.js';
import { larkMessageAnchor } from '../message-anchor.js';
import { memoryUnavailablePrompt } from '../prompt-contributors.js';
import type { TurnContext, TurnContributor, TurnPrompt } from './types.js';

export function memoryContributor({ task, config, event, session, materialPrompt, options, log, botSender }: TurnContext, prompt: TurnPrompt) {
  /**
   * 同群其他开了记忆的机器人在本群记下的约定，按内容去重（本机器人已有的 own 也算在内）；没有时返回 undefined。
   * 任何读取失败都只记日志并返回 undefined，不影响本轮注入自己的记忆。
   */
  async function peerGroupMemories(appId: string, chatId: string, own: LarkMemoryEntry[]): Promise<Array<{ botName: string; entry: LarkMemoryEntry }> | undefined> {
    const memoryStore = options.memory?.store;
    const configStore = options.store;
    if (!memoryStore || !configStore) return undefined;
    try {
      const allBots = await withLarkContextReadTimeout(readLarkConfigs(configStore, { readOnly: true }), '机器人配置读取');
      const peerBots = allBots.filter(b => b.appId !== appId && larkMemoryEnabled(b));
      if (peerBots.length === 0) return undefined;
      const peerResults = await withLarkContextReadTimeout(Promise.all(peerBots.map(async peerBot => {
        try {
          // 对端的群共享池里也有它在别的群记下的条目，下面只取本群的。只读：不替对端触发旧账本迁移。
          const peerList = await memoryStore.peek(larkMemoryScope(peerBot.appId, chatId, 'group', peerBot.groupMemoryScope));
          const botName = peerBot.name?.trim() || peerBot.displayName?.trim() || peerBot.appId;
          return { botName, peerList };
        } catch {
          return undefined;
        }
      })), '同群其他机器人记忆读取');
      const seen = new Set(own.map(e => e.content.trim()));
      const collected: Array<{ botName: string; entry: LarkMemoryEntry }> = [];
      for (const res of peerResults) {
        if (!res) continue;
        for (const item of res.peerList) {
          if (item.topic !== 'conventions' || item.chatId !== chatId) continue;
          const text = item.content.trim();
          if (seen.has(text)) continue;
          seen.add(text);
          collected.push({ botName: res.botName, entry: item });
        }
      }
      return collected.length > 0 ? collected : undefined;
    } catch (peerError) {
      log.warn({ error: peerError, chatId }, '读取同群其他机器人偏好失败，跳过共享记忆');
      return undefined;
    }
  }

  // 会话记忆随 agentPrompt 一起冻结进任务账本：事后能核对这一轮 Agent 看到的是哪几条记忆。
  // 读取失败只丢本轮注入并留日志，不阻断任务。注入了哪几条另记一份，供 Web 任务详情查看。
  let memoryTurn: { scope: LarkMemoryScope; ids: string[] } | undefined;
  return {
    async preparePrompt() {
      if (larkMemoryEnabled(config) && options.memory) {
        try {
          const { store } = options.memory;
          const scope = larkMemoryScope(config.appId, event.chatId, event.chatType, config.groupMemoryScope);
          const shared = isLarkGroupMemoryPool(scope);
          // 没有注入任何条目也要记：本轮 Agent 保存的、后台从本轮提取的记忆都按这份记录找到记忆池。
          memoryTurn = { scope, ids: [] };
          const [entries, state] = await withLarkContextReadTimeout(Promise.all([
            store.list(scope),
            store.getState(scope)
          ]), '会话记忆读取');

          const sharedEntries = event.chatType === 'group' ? await peerGroupMemories(config.appId, event.chatId, entries) : undefined;

          const index = renderMemoryIndex(entries, state, { ...(shared ? { currentChatId: event.chatId } : {}), sharedEntries, query: materialPrompt.slice(0, 2_000), budget: relevantMemoryBudget });
          prompt.memoryBlock = renderLarkMemoryInjection(index.text, { shared });
          if (prompt.memoryBlock) memoryTurn.ids = index.ids;
        } catch (error) {
          log.warn({ error, appId: config.appId, chatId: event.chatId, taskId: task.id }, '读取飞书会话记忆失败，本轮不注入记忆');
          prompt.memoryBlock = memoryUnavailablePrompt;
        }
      }
    },
    async attached(runtimeTask) {
      // 重放的是早先那次派发，本轮新读的记忆没有交给 Agent，记录以那一次为准。
      if (memoryTurn && !runtimeTask.replayed) {
        await options.memory!.store.recordTurn(memoryTurn.scope, { taskId: runtimeTask.id, sessionId: session.id, injected: memoryTurn.ids })
          .catch(error => log.warn({ error, runtimeTaskId: runtimeTask.id }, '记录本轮注入的会话记忆失败，结果卡不列本轮记忆'));
      }
    },
    afterDelivery(resolvedState, runtimeTaskId) {
      // 记忆提取排在终态交付之后，且只记真实 dispatch 过的完成轮次；失败只留日志。
      const memoryPipeline = options.memory?.pipeline;
      if (memoryPipeline && resolvedState === 'completed' && runtimeTaskId) {
        void memoryPipeline.onTurnCompleted(larkMemoryScope(config.appId, event.chatId, event.chatType, config.groupMemoryScope), { sessionId: session.id, taskId: runtimeTaskId, senderId: event.senderOpenId, senderKind: botSender ? 'bot' : 'human', sourceMessageId: larkMessageAnchor(event) })
          .catch(error => log.warn({ error, appId: config.appId, chatId: event.chatId, taskId: runtimeTaskId }, '飞书会话记忆后台提取触发失败'));
      }
    },
  } satisfies TurnContributor;
}
