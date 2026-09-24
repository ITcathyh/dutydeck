import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';

export interface SessionNameRouteOptions {
  /** 安装管理员校验；未配置或返回 false 一律 fail closed（403）。 */
  authorize(request: FastifyRequest): Promise<boolean> | boolean;
}

const patchSessionNameBodySchema = z.object({
  name: z.string().nullable()
}).strict();

export function registerSessionNameRoutes(
  app: FastifyInstance,
  runtime: DutydeckRuntime,
  options?: SessionNameRouteOptions
) {
  app.patch<{ Params: { id: string } }>('/api/sessions/:id/name', async request => {
    if (!options || !await options.authorize(request)) {
      throw new RuntimeError('SESSION_NAME_OWNER_REQUIRED', 'Installation owner authorization is required', 403);
    }
    const body = patchSessionNameBodySchema.parse(request.body);
    return runtime.setSessionName(request.params.id, body.name);
  });
}
