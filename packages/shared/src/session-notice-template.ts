import { unknownTaskActionLabels } from './execution-recovery.js';
import type { ExecutionBlocker } from './index.js';

export type NoticeFacts =
  | { kind: 'workspace_blocked'; blockers: Array<{ block: ExecutionBlocker; unknown: boolean }> }
  | { kind: 'stop_unverified'; cause: 'startup' | 'idle'; unverifiable: boolean }
  | { kind: 'unknown_task_abandoned' | 'unknown_task_overdue' | 'queue_expired' };

const workspaceBlockerStates: Record<string, string> = {
  WORKSPACE_PHYSICAL_RESOURCE_UNSAFE: '它的终端或执行进程还没确认已退出（残留终端）',
  DRIVER_STOP_BLOCKED: '它上次停止时没能确认进程已退出（残留终端）',
  WORKSPACE_RESOURCE_UNVERIFIABLE: '它的工作目录身份无法核实',
  DRIVER_CONFIGURATION_UNKNOWN: '它上次改模型或权限的结果不明，需要恢复配置',
};

export function renderSessionNotice(facts: NoticeFacts): string {
  switch (facts.kind) {
    case 'workspace_blocked': {
      const kinds = new Set(facts.blockers.map(({ block, unknown }) => unknown ? 'unknown' : block.code));
      const lines = facts.blockers.map(({ block, unknown }) => {
        const state = unknown ? '这一轮结果未知，需要有人确认' : workspaceBlockerStates[block.code] ?? '它的执行环境需要恢复检查';
        return `- 会话 ${block.sessionId}${block.taskId ? ` 里的任务 ${block.taskId}` : ''}：${state}`;
      });
      const labels = unknownTaskActionLabels;
      const steps = [
        ...(kinds.has('unknown') ? [`结果未知的任务：在 Web 打开那个会话，在执行记录下方选「${labels.retry}」「${labels.completed}」或「${labels.failed}」；它的原话题里如果有「结果未知」提醒卡，也可以直接点。`] : []),
        ...(['WORKSPACE_PHYSICAL_RESOURCE_UNSAFE', 'DRIVER_STOP_BLOCKED'].some(code => kinds.has(code)) ? ['残留终端：用 `dutydeck recovery inspect <会话 ID>` 查看；确认进程已退出后用 `dutydeck recovery retire-pty` 回收。'] : []),
        ...(kinds.has('DRIVER_CONFIGURATION_UNKNOWN') ? ['配置结果不明：用 `dutydeck recovery restore-configuration <会话 ID> --run-id <运行 ID>` 恢复配置。'] : []),
      ];
      return [`这条消息还没开始执行：同一仓库里有未结的任务或残留终端，为避免两边同时改同一份代码，要等它处理完。挡住它的是：\n${lines.join('\n')}`,
        ...steps, '处理完之后这里会自动继续，不用重发；但排队超过 24 小时仍未开始的消息，到时会取消、不再执行。'].join('\n\n');
    }
    case 'unknown_task_overdue': return ['这一轮的结果未知，已经超过 24 小时没人处理。它会挡住这个会话后面的消息，也会挡住同一仓库里其他会话的任务。',
        `处理方法：在 Web 打开这个会话，在执行记录下方选「${unknownTaskActionLabels.retry}」「${unknownTaskActionLabels.completed}」或「${unknownTaskActionLabels.failed}」；原话题里如果有「结果未知」提醒卡，也可以直接点。`,
        '超过 7 天仍没人处理、且确认执行它的进程已退出时，Dutydeck 会自动按「结果未知、已放弃」结案，不会重做。'].join('\n\n');
    case 'unknown_task_abandoned': return '这一轮的结果未知，超过 7 天没人处理，执行它的进程也已确认退出。Dutydeck 已按「结果未知、已放弃」结案：没有重做，也不算完成，不再挡住同一仓库的其他任务。\n\n还需要做的话，请重新发一条消息。';
    case 'queue_expired': return '排队超过 24 小时仍未开始，已取消、不会执行；需要的话请重发。';
    case 'stop_unverified': return facts.unverifiable ? '这个会话的 Agent 进程没法确认是否已经退出，后台不会再自动复核。新消息会先排队，请管理员核对进程后在执行恢复里解除。'
        : facts.cause === 'startup' ? '这个会话启动 Agent 失败后，没能确认启动到一半的进程已经退出，暂时不能接新消息。后台会定时复核，确认退出后自动恢复。'
        : '这个会话闲置关闭时，没能确认它的终端进程已经退出，暂时不能接新消息。后台会定时复核，确认退出后自动恢复。';
  }
}
