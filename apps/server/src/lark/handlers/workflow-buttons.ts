import type { CallbackHandler } from './button-context.js';

export const confirm: CallbackHandler = async (ctx, { operatorOpenId, context }) => {
  const participation = ctx.participation;
  const result = participation && ctx.reconcileConfig ? await participation.confirmations.handle(ctx.reconcileConfig.appId, workflow, operatorOpenId, context) : undefined;
  return result ?? { type: 'warning', content: '这张确认卡已失效。' };
};
