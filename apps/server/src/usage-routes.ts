import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import type { UsageLedger } from './usage-ledger.js';

export interface UsageRouteOptions {
  ledger: UsageLedger;
  /** 安装管理员校验；汇总与上限跨所有 Bot，未授权一律 403。 */
  authorize(request: FastifyRequest): Promise<boolean> | boolean;
}

const appId = z.string().trim().min(1).max(128);
const botTarget = { scope: z.literal('bot'), appId };
const groupTarget = { scope: z.literal('group'), appId, chatId: z.string().trim().regex(/^oc_/, '群 ID 以 oc_ 开头').max(128) };
const monthlyCostUsd = z.number().positive().max(1_000_000);
const capTarget = z.discriminatedUnion('scope', [z.object(botTarget).strict(), z.object(groupTarget).strict()]);
const capBody = z.discriminatedUnion('scope', [z.object({ ...botTarget, monthlyCostUsd }).strict(), z.object({ ...groupTarget, monthlyCostUsd }).strict()]);

export function registerUsageRoutes(app: FastifyInstance, options: UsageRouteOptions, requireSessionView: (request: FastifyRequest, sessionId: string) => Promise<unknown>) {
  const authorize = async (request: FastifyRequest) => {
    if (!await options.authorize(request)) throw new RuntimeError('USAGE_OWNER_REQUIRED', '安装管理员授权后才能查看用量汇总和设置上限', 403);
  };

  app.get('/api/usage/summary', async request => {
    await authorize(request);
    return options.ledger.summary();
  });

  app.put('/api/usage/caps', async request => {
    await authorize(request);
    const { monthlyCostUsd, ...target } = capBody.parse(request.body);
    return options.ledger.setCap({ ...target, monthlyCostUsd });
  });

  app.delete('/api/usage/caps', async request => {
    await authorize(request);
    const target = capTarget.parse(request.query);
    return { deleted: await options.ledger.deleteCap(target.scope, target.appId, target.scope === 'group' ? target.chatId : undefined) };
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/usage', async request => {
    await requireSessionView(request, request.params.id);
    return options.ledger.sessionUsage(request.params.id);
  });
}
