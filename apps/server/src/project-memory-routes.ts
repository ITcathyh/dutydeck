import { hasPluginTaskCredentials } from './plugins/management-auth.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RuntimeError } from '@dutydeck/shared';
import type { ProjectMemoryService } from './project-memory.js';

export interface ProjectMemoryRouteOptions {
  service: ProjectMemoryService;
  authorize(request: FastifyRequest): Promise<boolean> | boolean;
  authorizeSession(request: FastifyRequest, sessionId: string): Promise<unknown>;
}
const write = z.object({ content: z.string(), topic: z.string().optional(), expectedFingerprint: z.string().min(1) }).strict();
export function registerProjectMemoryRoutes(app: FastifyInstance, options: ProjectMemoryRouteOptions) {
  const owner = async (request: FastifyRequest) => {
    if (hasPluginTaskCredentials(request) || !await options.authorize(request)) throw new RuntimeError('PROJECT_MEMORY_OWNER_REQUIRED', '项目记忆需要安装管理员权限。', 403);
  };
  app.get('/api/project-memory', async request => { await owner(request); return options.service.list(); });
  app.post('/api/project-memory', async request => { await owner(request); return options.service.create(z.object({ name: z.string() }).strict().parse(request.body).name); });
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/project-memory/:id', async request => { await owner(request); return options.service.view(request.params.id, request.query.q); });
  app.patch<{ Params: { id: string } }>('/api/project-memory/:id', async request => { await owner(request); return options.service.setEnabled(request.params.id, z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled); });
  app.post<{ Params: { id: string } }>('/api/project-memory/:id/entries', async request => { await owner(request); return options.service.write(request.params.id, write.parse(request.body)); });
  app.patch<{ Params: { id: string; entryId: string } }>('/api/project-memory/:id/entries/:entryId', async request => { await owner(request); return options.service.write(request.params.id, { ...write.parse(request.body), entryId: request.params.entryId }); });
  app.delete<{ Params: { id: string; entryId: string } }>('/api/project-memory/:id/entries/:entryId', async request => { await owner(request); return options.service.remove(request.params.id, request.params.entryId); });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/project-memory', async request => { await owner(request); await options.authorizeSession(request, request.params.id); return options.service.binding(request.params.id); });
  app.put<{ Params: { id: string } }>('/api/sessions/:id/project-memory', async request => { await owner(request); await options.authorizeSession(request, request.params.id); return options.service.bind(request.params.id, z.object({ projectId: z.string().nullable() }).strict().parse(request.body).projectId); });
}
