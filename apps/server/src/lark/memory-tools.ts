/**
 * 会话记忆的 Agent 工具面：复用群协作工具的 capability token（Bearer）与路径前缀，
 * 因此走 app.ts 里同一条鉴权豁免规则；作用域由 token 绑定的会话决定，请求体不能指定别的聊天。
 * 会话类型取自 capability 解析时按会话 sourceId（`<appId>:<chatId>:group|p2p:…`）重算的绑定：
 * 群会话读写本机器人的群共享池，私聊会话只读写自己的池。
 */
import type { FastifyInstance } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import { agentGroupToolBearerToken, type LarkAgentToolsService } from './agent-tools.js';
import { LarkMemoryError, larkMemoryScope, normalizeLarkMemoryTopic, type LarkMemoryStore } from './memory.js';

export interface LarkMemoryToolsOptions {
  tools: Pick<LarkAgentToolsService, 'memoryContext'>;
  store: LarkMemoryStore;
  /** 有活动任务时把触发该轮的发送人记为 createdBy、把该轮记为 taskId，便于追溯是谁的指令、哪一轮让 Agent 记住了它。 */
  runtime?: { getActiveTaskContext(sessionId: string): { taskId?: string; actorId?: string } | undefined };
}

export const larkMemoryToolsPath = '/api/lark/agent-tools/memory';

export async function registerLarkMemoryTools(app: FastifyInstance, options: LarkMemoryToolsOptions) {
  const scopeFor = async (authorization?: string) => {
    const binding = await options.tools.memoryContext(agentGroupToolBearerToken(authorization));
    const active = options.runtime?.getActiveTaskContext(binding.sessionId);
    return {
      scope: larkMemoryScope(binding.appId, binding.chatId, binding.chatType),
      sessionId: binding.sessionId,
      taskId: active?.taskId,
      actorId: active?.actorId
    };
  };

  // 1. list（可选 topic 过滤）
  app.get<{ Querystring: { topic?: string } }>(larkMemoryToolsPath, async request => {
    const { scope } = await scopeFor(request.headers.authorization);
    let entries = await options.store.list(scope);
    if (request.query.topic) {
      const topic = normalizeLarkMemoryTopic(request.query.topic);
      entries = entries.filter(entry => entry.topic === topic);
    }
    return { chatId: scope.chatId, entries };
  });

  // 2. show 单个主题（返回该主题全部有效条目，不存在返回空数组）
  app.get<{ Params: { topic: string } }>(`${larkMemoryToolsPath}/topics/:topic`, async request => {
    const { scope } = await scopeFor(request.headers.authorization);
    const topic = normalizeLarkMemoryTopic(request.params.topic);
    const live = await options.store.list(scope);
    const entries = live.filter(entry => entry.topic === topic);
    return { chatId: scope.chatId, topic, entries };
  });

  // 3. search 搜索
  app.get<{ Querystring: { q?: string; topic?: string; limit?: string } }>(`${larkMemoryToolsPath}/search`, async request => {
    const { scope } = await scopeFor(request.headers.authorization);
    const query = request.query.q ?? '';
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    const entries = await options.store.search(scope, {
      query,
      topic: request.query.topic,
      limit
    });
    return { chatId: scope.chatId, query, entries };
  });

  // 4. add 新增（可选 topic）
  app.post<{ Body: { content?: unknown; topic?: unknown } }>(larkMemoryToolsPath, async request => {
    const { scope, sessionId, taskId, actorId } = await scopeFor(request.headers.authorization);
    const content = request.body?.content;
    if (typeof content !== 'string') throw new RuntimeError('MEMORY_CONTENT_REQUIRED', '请求体需要字符串字段 content。', 400);
    const topic = typeof request.body?.topic === 'string' ? request.body.topic : undefined;
    try {
      const entry = await options.store.add(scope, {
        content,
        source: 'agent',
        sessionId,
        chatId: scope.chatId,
        ...(taskId ? { taskId } : {}),
        ...(topic ? { topic } : {}),
        ...(actorId ? { createdBy: actorId } : {})
      });
      return { chatId: scope.chatId, entry };
    } catch (error) {
      // 被拒的内容本身往往就是凭据或注入指令，只记原因不记内容。
      if (error instanceof LarkMemoryError && ['MEMORY_CREDENTIAL_REJECTED', 'MEMORY_INJECTION_REJECTED'].includes(error.code)) {
        request.log.warn({ code: error.code, appId: scope.appId, pool: scope.pool, sessionId }, 'Agent 写入会话记忆被拒绝');
      }
      throw error;
    }
  });

  // 5. delete 删除
  app.delete<{ Params: { id: string } }>(`${larkMemoryToolsPath}/:id`, async request => {
    const { scope, actorId } = await scopeFor(request.headers.authorization);
    const removed = await options.store.remove(scope, request.params.id, actorId);
    if (!removed) throw new RuntimeError('MEMORY_NOT_FOUND', `当前可见的记忆里没有编号为 ${request.params.id} 的条目。`, 404);
    return { chatId: scope.chatId, removed };
  });
}
