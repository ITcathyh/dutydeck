/**
 * Web 任务详情里的「本轮记忆」：列出会话最近几轮注入与新记下的记忆，并删除其中一条。
 * 鉴权由 app.ts 注入，沿用会话路由的执行策略，动作与飞书 /forget 的命令层门禁同为 task.view_result。
 * 只接受这一轮列出过的条目：Web 上的删除按钮不是任意删记忆的入口。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import type { LarkMemoryEntry, LarkMemoryStore } from './memory.js';

export interface LarkMemoryTurnRoutesOptions {
  store: Pick<LarkMemoryStore, 'turn' | 'turns' | 'remove'>;
  authorize(request: FastifyRequest, sessionId: string): Promise<unknown>;
}

/** 页面只列最近几轮。 */
const maxTurns = 10;

const publicEntry = (entry: LarkMemoryEntry) => ({
  id: entry.id, content: entry.content, topic: entry.topic, source: entry.source, createdAt: entry.createdAt,
  ...(entry.deletedAt ? { deletedAt: entry.deletedAt } : {})
});

export async function registerLarkMemoryTurnRoutes(app: FastifyInstance, options: LarkMemoryTurnRoutesOptions) {
  app.get<{ Params: { id: string } }>('/api/sessions/:id/memory', async request => {
    const sessionId = request.params.id;
    await options.authorize(request, sessionId);
    const turns = (await options.store.turns(sessionId))
      .filter(view => view.injected.length || view.written.length)
      .slice(0, maxTurns)
      .map(view => ({ taskId: view.record.taskId, at: view.record.at, shared: view.shared, injected: view.injected.map(publicEntry), written: view.written.map(publicEntry) }));
    return { turns };
  });

  app.delete<{ Params: { id: string; taskId: string; memoryId: string } }>('/api/sessions/:id/memory/:taskId/entries/:memoryId', async request => {
    const { id: sessionId, taskId, memoryId } = request.params;
    await options.authorize(request, sessionId);
    const view = await options.store.turn(sessionId, taskId);
    if (!view) throw new RuntimeError('MEMORY_TURN_NOT_FOUND', '这一轮任务没有记忆记录，或记录已过期。', 404);
    if (![...view.injected, ...view.written].some(entry => entry.id === memoryId)) {
      throw new RuntimeError('MEMORY_NOT_FOUND', `这一轮任务没有用到或记下编号为 ${memoryId} 的记忆。`, 404);
    }
    const removed = await options.store.remove(view.scope, memoryId, 'web');
    if (!removed) throw new RuntimeError('MEMORY_NOT_FOUND', `记忆 ${memoryId} 已经删除过了。`, 404);
    return { removed: { id: removed.id } };
  });
}
