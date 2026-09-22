import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { executionRecoveryDecisionSchema, ptyRetirementRecoverySchema, nativeReplacementRecoverySchema, RuntimeError } from '@dutydeck/shared';

export interface RecoveryRouteOptions {
  authorize(request: FastifyRequest): Promise<boolean> | boolean;
}
const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;
export function registerRecoveryRoutes(app: FastifyInstance, runtime: DutydeckRuntime, options?: RecoveryRouteOptions) {
  const authorize = async (request: FastifyRequest) => {
    if (!options || !await options.authorize(request)) throw new RuntimeError('RECOVERY_OWNER_REQUIRED', 'Installation owner authorization is required', 403);
  };
  app.get<{ Params: { id: string } }>('/api/sessions/:id/recovery', async request => {
    await authorize(request);
    return runtime.inspectExecutionRecovery(request.params.id, owner);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/recovery/probe', async request => {
    await authorize(request);
    const { runId } = z.object({ runId: z.string().min(1) }).strict().parse(request.body);
    return runtime.probeExecutionRecovery(request.params.id, runId, owner);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/recovery/confirm', { bodyLimit: 4 * 1024 * 1024 }, async request => {
    await authorize(request);
    return runtime.confirmExecutionRecovery(request.params.id, executionRecoveryDecisionSchema.parse(request.body), owner);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/recovery/retire-pty', async request => {
    await authorize(request);
    return runtime.retirePtyExecution(request.params.id, ptyRetirementRecoverySchema.parse(request.body), owner);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/recovery/replace-native', async request => {
    await authorize(request);
    const input = nativeReplacementRecoverySchema.parse(request.body);
    return runtime.replaceNativeContext(request.params.id, owner, input.resourceId, input.expectedRevision, input.decisionId, input.runId);
  });

}
