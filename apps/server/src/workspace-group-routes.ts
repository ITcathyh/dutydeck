import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import type { WorkspaceOrganizationService } from './workspace-organization.js';

export interface WorkspaceGroupRouteOptions {
  service: WorkspaceOrganizationService;
  /** 安装管理员校验；未配置或返回 false 一律 fail closed（403）。 */
  authorize(request: FastifyRequest): Promise<boolean> | boolean;
}

const createGroupBodySchema = z.object({
  name: z.string()
}).strict();

const renameGroupBodySchema = z.object({
  name: z.string()
}).strict();

const assignmentBodySchema = z.object({
  groupId: z.string().nullable(),
  sessionIds: z.array(z.string().min(1)).min(1).optional(),
  directories: z.array(z.string().min(1)).min(1).optional()
}).strict()
  .refine(body => (body.sessionIds?.length ?? 0) > 0 || (body.directories?.length ?? 0) > 0, {
    message: 'sessionIds 或 directories 至少提供一个非空数组',
    path: ['sessionIds']
  });

export function registerWorkspaceGroupRoutes(app: FastifyInstance, options?: WorkspaceGroupRouteOptions) {
  const authorize = async (request: FastifyRequest) => {
    if (!options || !await options.authorize(request)) {
      throw new RuntimeError('WORKSPACE_GROUP_OWNER_REQUIRED', '安装管理员授权后才能整理工作区分组', 403);
    }
  };

  app.get('/api/workspace-groups', async request => {
    await authorize(request);
    return options!.service.getSnapshot();
  });

  app.post('/api/workspace-groups', async request => {
    await authorize(request);
    const body = createGroupBodySchema.parse(request.body);
    return options!.service.createGroup(body.name);
  });

  app.patch<{ Params: { id: string } }>('/api/workspace-groups/:id', async request => {
    await authorize(request);
    const body = renameGroupBodySchema.parse(request.body);
    return options!.service.renameGroup(request.params.id, body.name);
  });

  app.delete<{ Params: { id: string } }>('/api/workspace-groups/:id', async request => {
    await authorize(request);
    return options!.service.deleteGroup(request.params.id);
  });

  app.put('/api/workspace-groups/assignments', async request => {
    await authorize(request);
    const body = assignmentBodySchema.parse(request.body);
    return options!.service.assign({ groupId: body.groupId, sessionIds: body.sessionIds, directories: body.directories });
  });
}
