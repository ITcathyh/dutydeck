import { parseLarkSourceId, type MatterSessionInput, type MatterTracking, type RepositoryBundle, type Session, type TaskRecord } from '@dutydeck/shared';

/** 旁路关联；失败只告警，绝不改变已受理任务的结果。 */
export class MattersService implements MatterTracking {
  constructor(private readonly repos: Pick<RepositoryBundle, 'matters' | 'sessions' | 'tasks'>) {}
  private async safely(work: () => Promise<void> | void) {
    try { await work(); } catch { console.warn('MATTER_LINK_FAILED'); }
  }
  async session(sessionId: string, input: MatterSessionInput = {}) {
    await this.safely(async () => {
      if (!this.repos.matters) return;
      if (input.sourceSessionId && !this.repos.matters.find('session', input.sourceSessionId)) {
        const [first] = await this.repos.tasks.listBySession(input.sourceSessionId);
        this.repos.matters.ensureSession({ sessionId: input.sourceSessionId, title: first?.prompt ?? input.title ?? '未命名事项' });
      }
      const matter = this.repos.matters.ensureSession({ sessionId, title: input.title ?? '未命名事项', ...input });
      if (input.sourceSessionId && input.sourceSessionId !== sessionId && ['handoff', 'agent_switch', 'retry'].includes(input.relation ?? '')) {
        this.repos.matters.link({ matterId: matter.id, kind: 'reply_target', refId: `session:${input.sourceSessionId}`, relation: input.relation! });
      }
      if (input.originMessageId) this.repos.matters.link({ matterId: matter.id, kind: 'origin_message', refId: `${input.originAppId ?? ''}:${input.originChatId ?? ''}:${input.originMessageId}`, relation: 'origin' });
    });
  }
  async accepted(session: Session, task: TaskRecord) {
    await this.safely(async () => {
      const source = session.source === 'lark' ? parseLarkSourceId(session.sourceId) : undefined;
      await this.session(session.id, { title: task.prompt, ...(source?.appId ? { originAppId: source.appId, originChatId: source.chatId } : {}) });
      const matter = this.repos.matters?.find('session', session.id);
      if (matter) this.repos.matters!.link({ matterId: matter.id, kind: 'task', refId: task.id, relation: 'created_in' });
    });
  }
  summary(sessionId: string) {
    try {
      const matter = this.repos.matters?.find('session', sessionId);
      return matter ? { id: matter.id, title: matter.title, status: matter.status, supersededSessionIds: this.repos.matters!.links(matter.id).filter(link => link.kind === 'reply_target' && link.refId.startsWith('session:')).map(link => link.refId.slice(8)), sessionIds: this.repos.matters!.links(matter.id).filter(link => link.kind === 'session').map(link => link.refId) } : undefined;
    } catch { console.warn('MATTER_READ_FAILED'); return undefined; }
  }
}
