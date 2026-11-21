import { runtimeStateKeys, unknownTaskActionLabels, type ExecutionBlocker, type RepositoryBundle, type Session } from '@dutydeck/shared';
import type { RuntimeOptions, SessionNotice } from '../index.js';
import { digest } from '../digest.js';
import type { SessionMutations } from '../ownership.js';
import type { SessionGate } from '../session-gate.js';

const workspaceBlockerStates: Record<string, string> = {
  WORKSPACE_PHYSICAL_RESOURCE_UNSAFE: '它的终端或执行进程还没确认已退出（残留终端）',
  DRIVER_STOP_BLOCKED: '它上次停止时没能确认进程已退出（残留终端）',
  WORKSPACE_RESOURCE_UNVERIFIABLE: '它的工作目录身份无法核实',
  DRIVER_CONFIGURATION_UNKNOWN: '它上次改模型或权限的结果不明，需要恢复配置',
};

export class Notices {
  /** 受阻期：排头任务被同仓库挡住后记下，认领成功或队列清空时删掉；noticed 表示这一期已留过会话提醒。 */
  private readonly workspaceBlocks = new Map<string, { taskId: string; noticed: boolean }>();

  constructor(
    private readonly config: RepositoryBundle['config'],
    private readonly options: Pick<RuntimeOptions, 'log' | 'onSessionNotice'>,
    private readonly mutations: SessionMutations,
    private readonly gate: SessionGate,
    private readonly emitStatus: (id: string, data: unknown, eventId: string) => Promise<unknown>,
  ) {}

  clearWorkspaceBlock(id: string) { this.workspaceBlocks.delete(id); }

  /**
   * 排头任务被同一仓库里别的会话挡住。每个受阻期（同一条排头任务）只写一次告警日志；挡它的会话里没有正在跑、
   * 会自己结束的任务时，再在会话里留一条提醒，说明被谁挡住、怎么处理、处理后会自动继续。
   */
  async noteWorkspaceBlocked(session: Session, taskId: string, details: unknown) {
    const current = this.workspaceBlocks.get(session.id);
    if (current?.taskId === taskId && current.noticed) return;
    if (!Array.isArray(details) || !details.length || !details.every((block): block is ExecutionBlocker =>
      typeof block?.sessionId === 'string' && typeof block.code === 'string')) return;
    const blockers = details;
    if (current?.taskId !== taskId) this.options.log?.warn({ sessionId: session.id, taskId, code: 'WORKSPACE_RESOURCE_BLOCKED',
      blockers: blockers.map(block => ({ code: block.code, sessionId: block.sessionId, ...(block.taskId ? { taskId: block.taskId } : {}), ...(block.resourceId ? { resourceId: block.resourceId } : {}) })) },
      'Queued task is blocked by another session in the same workspace');
    const stuck = new Map<string, string>();
    const kinds = new Set<string>();
    for (const { block, unknown } of this.gate.stuckWorkspaceBlockers(blockers)) {
      kinds.add(unknown ? 'unknown' : block.code);
      const state = unknown ? '这一轮结果未知，需要有人确认' : workspaceBlockerStates[block.code] ?? '它的执行环境需要恢复检查';
      stuck.set(block.sessionId, `- 会话 ${block.sessionId}${block.taskId ? ` 里的任务 ${block.taskId}` : ''}：${state}`);
    }
    this.workspaceBlocks.set(session.id, { taskId, noticed: stuck.size > 0 });
    if (!stuck.size) return;
    const labels = unknownTaskActionLabels;
    const steps = [
      ...(kinds.has('unknown') ? [`结果未知的任务：在 Web 打开那个会话，在执行记录下方选「${labels.retry}」「${labels.completed}」或「${labels.failed}」；它的原话题里如果有「结果未知」提醒卡，也可以直接点。`] : []),
      ...(['WORKSPACE_PHYSICAL_RESOURCE_UNSAFE', 'DRIVER_STOP_BLOCKED'].some(code => kinds.has(code)) ? ['残留终端：用 `dutydeck recovery inspect <会话 ID>` 查看；确认进程已退出后用 `dutydeck recovery retire-pty` 回收。'] : []),
      ...(kinds.has('DRIVER_CONFIGURATION_UNKNOWN') ? ['配置结果不明：用 `dutydeck recovery restore-configuration <会话 ID> --run-id <运行 ID>` 恢复配置。'] : []),
    ];
    await this.sessionNotice(session, { id: `notice_${digest(['workspace_blocked', session.id, taskId])}`, kind: 'workspace_blocked', taskId, sessionIds: [...stuck.keys()],
      message: [`这条消息还没开始执行：同一仓库里有未结的任务或残留终端，为避免两边同时改同一份代码，要等它处理完。挡住它的是：\n${[...stuck.values()].join('\n')}`,
        ...steps, '处理完之后这里会自动继续，不用重发；但排队超过 24 小时仍未开始的消息，到时会取消、不再执行。'].join('\n\n') }, { key: runtimeStateKeys.notice.key('workspace_blocked', session.id), value: taskId });
  }
  /**
   * 会话提醒：once.key 已记成 once.value 就不再提醒（重启后也不重发）。先在会话里写一条 status=notice 事件
   * （Web 时间线显示），再交给宿主投递（飞书会话转到原话题）；投递失败只记日志。
   */
  async sessionNotice(session: Session, notice: SessionNotice, once?: { key: string; value: string }) {
    if (once && await this.mutations.wait(() => this.config.get(once.key)) === once.value) return;
    await this.emitStatus(session.id, { state: 'notice', kind: notice.kind, taskId: notice.taskId, message: notice.message }, `evt_${notice.id}`);
    if (once) await this.mutations.wait(() => this.config.set(once.key, once.value));
    const deliver = this.options.onSessionNotice;
    if (deliver) void Promise.resolve().then(() => deliver(session, notice))
      .catch(error => this.options.log?.warn({ sessionId: session.id, taskId: notice.taskId, kind: notice.kind, error }, 'Session notice delivery failed'));
  }
}
