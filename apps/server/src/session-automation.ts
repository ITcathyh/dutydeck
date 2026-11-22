import { AutomationScheduler } from './automation/scheduler.js';
import { scheduleKey, type SessionAutomationServiceOptions } from './automation/store.js';
import {
  sessionScheduleSchema,
  type AutomationHistoryPage,
  type AutomationRunDetail,
  type AutomationSchedulePage,
  type AutomationScheduleQuery,
  type CreateSessionScheduleInput,
  type DeleteSessionScheduleInput,
  type PublicCiProvider,
  type PublicCiSubscription,
  type PublicSessionSchedule,
  type PublicSessionScheduleOccurrence,
  type RunSessionScheduleInput,
  type Session,
  type SessionAutomationList,
  type SessionSchedule,
  type SubscribeCiInput,
  type TaskRecord,
  type UpdateSessionScheduleInput
} from '@dutydeck/shared';

export {
  type SessionAutomationRuntime,
  type ScheduleOverdueNotice,
  type AutomationDeliveryContext,
  type SessionAutomationServiceOptions,
  type ScheduleWorkTemplates,
  scheduleRequestKey,
  ciRequestKey
} from './automation/store.js';

export { scheduleTaskPrompt } from './automation/occurrence-runner.js';

export class SessionAutomationService {
  private readonly scheduler: AutomationScheduler;

  constructor(private readonly options: SessionAutomationServiceOptions,
    public mandateCards?: { callback(appId: string, value: Record<string, unknown>, operatorId: string | undefined, context: { messageId?: string; chatId?: string }): Promise<string> }) {
    this.scheduler = new AutomationScheduler(options, this);
  }

  /** 至少装了一个 CI 插件；/ci 据此判断「未安装 CI 插件」。 */
  get ciConfigured() {
    return this.scheduler.ci.ciConfigured;
  }

  get ciWebhook() { return this.options.ciWebhook; }

  get pullRequests() { return this.options.pullRequests; }

  listCiProviders(): PublicCiProvider[] {
    return this.scheduler.ci.listCiProviders();
  }

  listBySession(sessionId: string, actorId?: string): Promise<SessionAutomationList> {
    return this.scheduler.store.listBySession(sessionId, actorId);
  }

  createSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId?: string, receipt?: { key: string; prepareDelivery?: (id: string) => Promise<void> }): Promise<PublicSessionSchedule> {
    return this.scheduler.store.createSchedule(sessionId, rawInput, actorId, receipt);
  }

  /**
   * 聊天里代建计划：同事项已有生效循环计划时拒绝新建；已停用同名计划保留兼容更新，不新建第二条。
   * 有实际改动时一并停用，等用户在确认卡上重新启用；没有改动时原样返回。同一请求重试拿回同一结果。
   * `newMode` 只在新建、请求没写模式、且本实例能开新会话时作为缺省；更新同名计划时不改它的模式。
   */
  requestSchedule(sessionId: string, rawInput: CreateSessionScheduleInput, actorId: string, receipt: { key: string; newMode?: 'fresh'; prepareDelivery?: (id: string) => Promise<void> }): Promise<{ schedule: PublicSessionSchedule; updated?: { changed: boolean; wasEnabled: boolean } }> {
    return this.scheduler.store.requestSchedule(sessionId, rawInput, actorId, receipt);
  }

  /** Map internal schedule execution back to its frozen source authority. */
  authorizeExecutionSession(sessionId: string, actorId?: string): Promise<boolean> {
    return this.scheduler.store.authorizeExecutionSession(sessionId, actorId);
  }

  sourceSessionId(sessionId: string): Promise<string | undefined> {
    return this.scheduler.store.sourceSessionId(sessionId);
  }

  /**
   * 计划每次在新会话执行、结果回原话题；这里补上两处衔接，只在这个会话还没用过这份结果时给：
   * 计划的新会话第一轮带上一次的结果摘要；原话题的会话在那次运行之后第一次接到消息时带最近一次的结果，用户多半是在跟进它。
   */
  resultContext(session: Session): Promise<string | undefined> {
    return this.scheduler.store.resultContext(session);
  }

  static async getSchedule(store: Pick<import('@dutydeck/shared').ConfigRepository, 'get'>, scheduleId: string): Promise<Pick<SessionSchedule, 'id' | 'name' | 'sessionId'> | undefined> {
    const raw = await store.get(scheduleKey(scheduleId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      const strict = sessionScheduleSchema.safeParse(parsed);
      if (strict.success) {
        return { id: strict.data.id, name: strict.data.name, sessionId: strict.data.sessionId };
      }
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && typeof parsed.name === 'string' && typeof parsed.sessionId === 'string') {
        return { id: parsed.id, name: parsed.name, sessionId: parsed.sessionId };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async getSchedule(scheduleId: string): Promise<Pick<SessionSchedule, 'id' | 'name' | 'sessionId'> | undefined> {
    return SessionAutomationService.getSchedule(this.options.repositories.config, scheduleId);
  }

  getScheduleDefinition(sessionId: string, id: string, actorId?: string): Promise<PublicSessionSchedule> {
    return this.scheduler.store.getScheduleDefinition(sessionId, id, actorId);
  }

  getScheduleHistory(sessionId: string, id: string, actorId?: string): Promise<PublicSessionScheduleOccurrence[]> {
    return this.scheduler.store.getScheduleHistory(sessionId, id, actorId);
  }

  listSchedules(query: AutomationScheduleQuery, authorize: (sessionId: string) => Promise<boolean | { actorId?: string }>): Promise<AutomationSchedulePage> {
    return this.scheduler.store.listSchedules(query, authorize);
  }

  getScheduleHistoryPage(sessionId: string, id: string, offset: number, limit: number, actorId?: string): Promise<AutomationHistoryPage> {
    return this.scheduler.store.getScheduleHistoryPage(sessionId, id, offset, limit, actorId);
  }

  getScheduleRun(sessionId: string, scheduleId: string, id: string, actorId?: string): Promise<AutomationRunDetail> {
    return this.scheduler.store.getScheduleRun(sessionId, scheduleId, id, actorId);
  }

  updateSchedule(sessionId: string, id: string, rawInput: UpdateSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    return this.scheduler.store.updateSchedule(sessionId, id, rawInput, actorId);
  }

  deleteSchedule(sessionId: string, id: string, rawInput: DeleteSessionScheduleInput, actorId?: string): Promise<PublicSessionSchedule> {
    return this.scheduler.store.deleteSchedule(sessionId, id, rawInput, actorId);
  }

  runSchedule(sessionId: string, id: string, rawInput: RunSessionScheduleInput, actorId?: string): Promise<PublicSessionScheduleOccurrence> {
    return this.scheduler.occurrences.runSchedule(sessionId, id, rawInput, actorId);
  }

  subscribeCi(sessionId: string, rawInput: SubscribeCiInput, actorId?: string): Promise<PublicCiSubscription> {
    return this.scheduler.ci.subscribeCi(sessionId, rawInput, actorId);
  }

  cancelCi(sessionId: string, id: string, rawInput: { expectedRevision: number }, actorId?: string): Promise<PublicCiSubscription> {
    return this.scheduler.ci.cancelCi(sessionId, id, rawInput, actorId);
  }

  /** No schedule ID is accepted: only the current occurrence's durable host binding can request this. */
  requestScheduleStop(sessionId: string, taskId: string, attemptId: string, actorId: string) {
    return this.scheduler.requestScheduleStop(sessionId, taskId, attemptId, actorId);
  }

  tick(): Promise<void> {
    return this.scheduler.tick();
  }

  close(): Promise<void> {
    return this.scheduler.close();
  }

  authorizeTask(task: TaskRecord, phase: 'prepare' | 'submit' = 'prepare'): Promise<void> {
    return this.scheduler.occurrences.authorizeTask(task, phase);
  }
}
