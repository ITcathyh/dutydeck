import type { TurnContext, TurnContributor, TurnVerification } from './types.js';

export function verificationContributor({ task, session, config, verification, log }: TurnContext) {
  let codeBefore: string | undefined;
  let autoVerification: Awaited<ReturnType<TurnVerification['plan']>>;
  return {
    async captureWorkspace() { codeBefore = await verification.fingerprint(task, session); },
    async planDelivery(state) {
      // 插话没有自己的一轮；自动验证属于当时正在执行的那一轮。
      autoVerification = state === 'completed' && !task.steered ? await verification.plan(task, codeBefore) : undefined;
    },
    async inspectResult(state, result) {
      const view = await verification.view(task, config, state, result.changedCode);
      result.verification = view.element;
      result.capabilities = view.capabilities;
    },
    afterDelivery() {
      if (autoVerification) void verification.run(task, autoVerification);
      // 本轮不自动验证：这个任务若是返修轮次，返修到此为止，登记的轮次移出待收尾。
      else if (config.verificationCommand?.trim() && !verification.inFlight(task.id)) {
        void verification.settle(config.appId, task.id).catch(error => log.warn({ error, taskId: task.id }, '移出待收尾的自动验证失败'));
      }
    },
  } satisfies TurnContributor;
}
