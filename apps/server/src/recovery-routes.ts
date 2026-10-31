import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import { executionRecoveryDecisionSchema, steeringRecoveryDecisionSchema, ptyRetirementRecoverySchema, nativeReplacementRecoverySchema, RuntimeError } from '@dutydeck/shared';
import { resolveUnknownTask, unknownTaskFactLines } from './task-resolution.js';

export interface RecoveryRouteOptions {
  authorize(request: FastifyRequest): Promise<boolean> | boolean;
  /** 这个会话里结果没送达飞书的轮次（已判定失败或正在退避重发），随 inspect 一起给出。 */
  larkResultDeliveries?(sessionId: string): Promise<unknown[]>;
}
const owner = { kind: 'installation_owner', id: 'installation_owner' } as const;
export function registerRecoveryRoutes(app: FastifyInstance, runtime: DutydeckRuntime, options?: RecoveryRouteOptions) {
  const authorize = async (request: FastifyRequest) => {
    if (!options || !await options.authorize(request)) throw new RuntimeError('RECOVERY_OWNER_REQUIRED', 'Installation owner authorization is required', 403);
  };
  app.get<{ Params: { id: string } }>('/api/sessions/:id/recovery', async request => {
    await authorize(request);
    const recovery = await runtime.inspectExecutionRecovery(request.params.id, owner);
    const larkResultDelivery = await options?.larkResultDeliveries?.(request.params.id) ?? [];
    return larkResultDelivery.length ? { ...recovery, larkResultDelivery } : recovery;
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
  app.post<{ Params: { id: string } }>('/api/sessions/:id/recovery/steering', async request => {
    await authorize(request);
    return runtime.confirmSteeringRecovery(request.params.id, steeringRecoveryDecisionSchema.parse(request.body), owner);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/recovery/retire-pty', async request => {
    await authorize(request);
    return runtime.retirePtyExecution(request.params.id, ptyRetirementRecoverySchema.parse(request.body), owner);
  });
  // 配置结果不明（模型或权限改到一半）：用原生会话重新下发当前配置并核实，成功后解除阻塞；不发任何 prompt。
  app.post<{ Params: { id: string } }>('/api/sessions/:id/recovery/restore-configuration', async request => {
    await authorize(request);
    const { runId } = z.object({ runId: z.string().min(1) }).strict().parse(request.body);
    await runtime.restoreNativeConfiguration(request.params.id, owner, runId);
    return runtime.inspectExecutionRecovery(request.params.id, owner);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/recovery/replace-native', async request => {
    await authorize(request);
    const input = nativeReplacementRecoverySchema.parse(request.body);
    return runtime.replaceNativeContext(request.params.id, owner, input.resourceId, input.expectedRevision, input.decisionId, input.runId);
  });

  // 结果未知的任务：Web 上与飞书提醒卡同样的三个操作。Web 用户都是安装管理员（同上面的 authorize）。
  app.get<{ Params: { id: string } }>('/api/sessions/:id/unknown-tasks', async request => {
    await authorize(request);
    const tasks = (await runtime.getTasks(request.params.id)).filter(task => task.status === 'reconcile_required');
    const facts = await Promise.all(tasks.map(async task => ({ task, facts: await runtime.inspectUnknownTask(request.params.id, task.id) })));
    return facts.filter(item => item.facts.actionable)
      .map(({ task, facts }) => ({ ...facts, prompt: task.prompt, factLines: unknownTaskFactLines(facts) }));
  });
  const resolveBody = z.object({ target: z.string().min(1), action: z.enum(['retry', 'completed', 'failed']), allowDuplicateEffects: z.literal(true).optional() }).strict();
  app.post<{ Params: { id: string; taskId: string } }>('/api/sessions/:id/unknown-tasks/:taskId', async request => {
    await authorize(request);
    const body = resolveBody.parse(request.body);
    // 重新执行可能重复上一轮的操作：Web 的确认框确认过才带这一项，服务端照样再要一次。
    if (body.action === 'retry' && body.allowDuplicateEffects !== true) throw new RuntimeError('DUPLICATE_EFFECTS_ACK_REQUIRED', 'Retry requires explicit duplicate-effects acknowledgement', 400);
    return resolveUnknownTask(runtime, { sessionId: request.params.id, taskId: request.params.taskId, target: body.target, action: body.action,
      operator: { channel: 'web', id: 'installation_owner' } });
  });

}
