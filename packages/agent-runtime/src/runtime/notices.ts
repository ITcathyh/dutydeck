import { runtimeStateKeys, type NoticeFacts, type ExecutionBlocker, type RepositoryBundle, type Session } from '@dutydeck/shared';
import type { SessionNotice } from '../index.js';
import type { RuntimeHost } from './host-ports.js';
import { digest } from '../digest.js';
import type { SessionMutations } from '../ownership.js';
import type { SessionGate } from '../session-gate.js';

export class Notices {
  /** 受阻期：排头任务被同仓库挡住后记下，认领成功或队列清空时删掉；noticed 表示这一期已留过会话提醒。 */
  private readonly workspaceBlocks = new Map<string, { taskId: string; noticed: boolean }>();

  constructor(
    private readonly config: RepositoryBundle['config'],
    private readonly options: Pick<RuntimeHost, 'log' | 'events' | 'renderNotice'>,
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
    const blockersNeedingAction = [...this.gate.stuckWorkspaceBlockers(blockers)];
    this.workspaceBlocks.set(session.id, { taskId, noticed: blockersNeedingAction.length > 0 });
    if (!blockersNeedingAction.length) return;
    await this.sessionNotice(session, { id: `notice_${digest(['workspace_blocked', session.id, taskId])}`, taskId, sessionIds: blockersNeedingAction.map(({ block }) => block.sessionId) },
      { kind: 'workspace_blocked', blockers: blockersNeedingAction }, { key: runtimeStateKeys.notice.key('workspace_blocked', session.id), value: taskId });
  }
  /**
   * 会话提醒：once.key 已记成 once.value 就不再提醒（重启后也不重发）。先在会话里写一条 status=notice 事件
   * （Web 时间线显示），再交给宿主投递（飞书会话转到原话题）；投递失败只记日志。
   */
  async sessionNotice(session: Session, identity: Omit<SessionNotice, 'message' | 'kind'>, facts: NoticeFacts, once?: { key: string; value: string }) {
    if (once && await this.mutations.wait(() => this.config.get(once.key)) === once.value) return;
    const notice: SessionNotice = { ...identity, kind: facts.kind, message: this.options.renderNotice(facts) };
    await this.emitStatus(session.id, { state: 'notice', kind: notice.kind, taskId: notice.taskId, message: notice.message }, `evt_${notice.id}`);
    if (once) await this.mutations.wait(() => this.config.set(once.key, once.value));
    if (this.options.events.observed) void Promise.resolve().then(() => this.options.events.publish({ type: 'notice', session, notice }))
      .catch(error => this.options.log?.warn({ sessionId: session.id, taskId: notice.taskId, kind: notice.kind, error }, 'Session notice delivery failed'));
  }
}
