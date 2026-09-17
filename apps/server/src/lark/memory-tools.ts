/**
 * 会话记忆的 Agent 工具面：复用群协作工具的 capability token（Bearer）与路径前缀，
 * 因此走 app.ts 里同一条鉴权豁免规则；作用域由 token 绑定的会话决定，请求体不能指定别的聊天。
 */
import type { FastifyInstance } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import { agentGroupToolBearerToken, type LarkAgentToolsService } from './agent-tools.js';
import { normalizeLarkMemoryTopic, type LarkMemoryStore } from './memory.js';

export interface LarkMemoryToolsOptions {
  tools: Pick<LarkAgentToolsService, 'memoryContext'>;
  store: LarkMemoryStore;
  /** 有活动任务时把触发该轮的发送人记为 createdBy，便于追溯是谁的指令让 Agent 记住了它。 */
  runtime?: { getActiveTaskContext(sessionId: string): { actorId?: string } | undefined };
}

export const larkMemoryToolsPath = '/api/lark/agent-tools/memory';

export async function registerLarkMemoryTools(app: FastifyInstance, options: LarkMemoryToolsOptions) {
  const scopeFor = async (authorization?: string) => {
    const binding = await options.tools.memoryContext(agentGroupToolBearerToken(authorization));
    return {
      scope: { appId: binding.appId, chatId: binding.chatId },
      sessionId: binding.sessionId,
      actorId: options.runtime?.getActiveTaskContext(binding.sessionId)?.actorId
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
    const { scope, sessionId, actorId } = await scopeFor(request.headers.authorization);
    const content = request.body?.content;
    if (typeof content !== 'string') throw new RuntimeError('MEMORY_CONTENT_REQUIRED', '请求体需要字符串字段 content。', 400);
    const topic = typeof request.body?.topic === 'string' ? request.body.topic : undefined;
    const entry = await options.store.add(scope, {
      content,
      source: 'agent',
      sessionId,
      ...(topic ? { topic } : {}),
      ...(actorId ? { createdBy: actorId } : {})
    });
    return { chatId: scope.chatId, entry };
  });

  // 5. delete 删除
  app.delete<{ Params: { id: string } }>(`${larkMemoryToolsPath}/:id`, async request => {
    const { scope, actorId } = await scopeFor(request.headers.authorization);
    const removed = await options.store.remove(scope, request.params.id, actorId);
    if (!removed) throw new RuntimeError('MEMORY_NOT_FOUND', `本聊天没有编号为 ${request.params.id} 的记忆。`, 404);
    return { chatId: scope.chatId, removed };
  });
}
