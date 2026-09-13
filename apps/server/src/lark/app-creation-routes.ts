import type { FastifyInstance } from 'fastify';
import { LarkAppCreationError, type LarkAppCreationJobManager } from './app-creation.js';

export async function registerLarkAppCreationRoutes(app: FastifyInstance, jobs?: Pick<LarkAppCreationJobManager, 'start' | 'get' | 'cancel' | 'retry'>) {
  const respond = async (reply: import('fastify').FastifyReply, action: () => Promise<unknown>, status = 200) => {
    reply.header('cache-control', 'no-store');
    if (!jobs) return reply.code(503).send({ error: { code: 'LARK_APP_CREATION_UNAVAILABLE', message: '本地配置存储不可用' } });
    try {
      const result = await action();
      if (!result) throw new LarkAppCreationError(404, '创建任务不存在');
      return reply.code(status).send(result);
    } catch (error) {
      return reply.code(error instanceof LarkAppCreationError ? error.statusCode : 500).send({
        error: { code: 'LARK_APP_CREATION_FAILED', message: error instanceof LarkAppCreationError ? error.message : '创建任务存储操作失败，请使用同一请求 ID 重试' },
      });
    }
  };
  app.post<{ Body: { requestId?: unknown; name?: unknown } }>('/api/lark/apps/create', (request, reply) =>
    respond(reply, () => jobs!.start(request.body?.requestId, request.body?.name), 202));
  app.get<{ Params: { jobId: string } }>('/api/lark/apps/create/:jobId', (request, reply) =>
    respond(reply, () => jobs!.get(request.params.jobId)));
  app.post<{ Params: { jobId: string } }>('/api/lark/apps/create/:jobId/cancel', (request, reply) =>
    respond(reply, () => jobs!.cancel(request.params.jobId)));
  app.post<{ Params: { jobId: string } }>('/api/lark/apps/create/:jobId/retry', (request, reply) =>
    respond(reply, () => jobs!.retry(request.params.jobId), 202));
}
