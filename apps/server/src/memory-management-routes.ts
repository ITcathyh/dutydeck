import { hasPluginTaskCredentials } from './plugins/management-auth.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError } from '@dutydeck/shared';
import { isLarkGroupMemoryPool, isLarkPerGroupMemoryPool, larkMemoryFingerprint, type LarkMemoryEntry, type LarkMemoryScope, type LarkMemoryStore } from './lark/memory.js';

export interface MemoryManagementOptions {
  store: LarkMemoryStore;
  scope(sessionId: string): Promise<LarkMemoryScope>;
  authorize(request: FastifyRequest, sessionId: string): Promise<unknown>;
  sourceSession(entry: LarkMemoryEntry): Promise<string | undefined>;
  canViewSource(request: FastifyRequest, sessionId: string): Promise<boolean>;
}

const reviseBody = z.object({ content: z.string(), topic: z.string().optional(), expectedFingerprint: z.string().min(1) }).strict();

/** Shared memory grants access to a fact, never to its original chat or task. */
export async function memoryManagementEntry(entry: LarkMemoryEntry, request: FastifyRequest, canView: MemoryManagementOptions['canViewSource'], sourceSession: MemoryManagementOptions['sourceSession']) {
  const { id, content, topic, source, createdAt, deletedAt, supersedes, supersededBy } = entry;
  const sessionId = await sourceSession(entry);
  const visible = sessionId && await canView(request, sessionId);
  return { id, content, topic, source, createdAt, deletedAt, supersedes, supersededBy,
    origin: visible ? { label: '来源会话', sessionId, taskId: entry.taskId } : { label: '来源不可访问或历史记录不可用' } };
}

export function registerMemoryManagementRoutes(app: FastifyInstance, options: MemoryManagementOptions) {
  const scope = async (request: FastifyRequest, sessionId: string) => {
    if (hasPluginTaskCredentials(request)) throw new RuntimeError('MEMORY_OWNER_REQUIRED', '管理记忆需要安装管理员权限。', 403);
    await options.authorize(request, sessionId);
    return options.scope(sessionId);
  };
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/sessions/:id/memory-pool', async request => {
    const target = await scope(request, request.params.id);
    const all = await options.store.listAll(target);
    const matches = request.query.q ? new Set((await options.store.search(target, { query: request.query.q, limit: 50 })).map(entry => entry.id)) : undefined;
    return { scope: isLarkGroupMemoryPool(target) ? '机器人共享群池' : isLarkPerGroupMemoryPool(target) ? '当前群' : '当前私聊',
      fingerprint: larkMemoryFingerprint(all), entries: await Promise.all(all.filter(entry => !matches || matches.has(entry.id)).map(entry => memoryManagementEntry(entry, request, options.canViewSource, options.sourceSession))),
      historyNotice: '仅保留最近 20 轮关联、最多 100 个删除记录；历史不包含完整提示词，过期记录不可用。' };
  });
  app.patch<{ Params: { id: string; entryId: string } }>('/api/sessions/:id/memory-pool/:entryId', async request => {
    const target = await scope(request, request.params.id);
    const body = reviseBody.parse(request.body);
    return { entry: await options.store.revise(target, request.params.entryId, { ...body, actor: 'installation_owner' }) };
  });
  app.delete<{ Params: { id: string; entryId: string } }>('/api/sessions/:id/memory-pool/:entryId', async request => {
    const target = await scope(request, request.params.id);
    const removed = await options.store.remove(target, request.params.entryId, 'installation_owner');
    if (!removed) throw new RuntimeError('MEMORY_NOT_FOUND', '记忆已删除或不存在。', 404);
    return { removed: { id: removed.id } };
  });
}
