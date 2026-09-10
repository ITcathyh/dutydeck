import { createHash, randomUUID } from 'node:crypto';
import type { AgentEvent, ConfigRepository, PermissionRequestData, PolicyAction } from '@dutydeck/shared';
import type { RelayAskBroker } from '@dutydeck/relay';
import type { LarkMessageEvent, LarkRuntime } from './listener.js';
import type { LarkCardService } from './service.js';
import { LarkServiceError } from './service.js';
import type { LarkCardElement } from './card-renderer.js';

export interface LarkInteractionContext {
  appId: string;
  sessionId: string;
  taskId: string;
  turn: number;
  event: LarkMessageEvent;
}
export interface LarkInteraction extends LarkInteractionContext {
  id: string;
  boot: string;
  kind: 'ask' | 'permission' | 'result';
  nativeId: string;
  question: string;
  state: 'pending' | 'resolving' | 'answered' | 'approved' | 'rejected' | 'expired' | 'accepted' | 'needs_changes';
  cardId?: string;
  updatedAt: string;
  actorId?: string;
}
const prefix = (appId: string) => `lark.interaction.${appId}.`;
const stale = () => new LarkServiceError('LARK_INTERACTION_EXPIRED', '此操作已处理或失效，请查看最新任务状态。', 409);
const button = (record: LarkInteraction, action: string, label: string): LarkCardElement => ({
  tag: 'button', element_id: `workflow_${action}`, text: { tag: 'plain_text', content: label }, type: action === 'approve' ? 'primary' : 'default',
  behaviors: [{ type: 'callback', value: { dutydeck_workflow: action, request_id: record.id, generation: record.boot } }]
});

/** Persisted cards identify a live waiter; history never recreates executable approvals. */
export class LarkWorkflowInteractions {
  readonly boot = randomUUID();
  private closed = false;
  private readonly delivering = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  constructor(
    private readonly store: ConfigRepository,
    private readonly runtime: LarkRuntime,
    private readonly service: LarkCardService,
    private readonly broker: RelayAskBroker | undefined,
    private readonly authorize: (record: LarkInteraction, actor: string, action: PolicyAction) => Promise<boolean>
  ) {
    if (!store.compareAndSet || !store.list) throw new Error('Lark workflows require persistent CAS and prefix listing');
  }
  private key(record: Pick<LarkInteraction, 'appId' | 'id'>) { return prefix(record.appId) + record.id; }
  async list(appId: string): Promise<LarkInteraction[]> {
    return (await this.store.list!(prefix(appId))).map(row => JSON.parse(row.value));
  }
  async initialize(appId: string) {
    for (const record of await this.list(appId)) {
      if (record.kind !== 'result' && ['pending', 'resolving'].includes(record.state)) {
        const expired = await this.move(record, 'expired');
        await this.renderClosed(expired, '原任务已失去确认上下文，此卡已失效。');
      }
    }
  }
  private async renderClosed(record: LarkInteraction, message: string) {
    if (!record.cardId || record.kind === 'result') return;
    await this.service.update({ messageId: record.cardId, taskId: record.id, taskName: record.kind === 'ask' ? 'Agent 提问' : '本次操作确认',
      permissionMode: 'ask', state: record.state === 'expired' ? 'interrupted' : 'completed', statusLabel: record.state === 'expired' ? '已失效' : '已处理',
      readOnly: true, elements: [{ tag: 'div', text: { tag: 'plain_text', content: record.question.slice(0, 6000) } }, { tag: 'markdown', content: message }] }).catch(() => undefined);
  }
  private async renderPendingPermission(record: LarkInteraction) {
    if (!record.cardId) return;
    await this.service.update({ messageId: record.cardId, taskId: record.id, taskName: '确认本次操作', permissionMode: 'ask', state: 'running', statusLabel: '等待审批', awaitingHuman: true, readOnly: true,
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: record.question.slice(0, 6000) } }, { tag: 'markdown', content: '上次提交未送达执行端，请重新批准或拒绝。' }, button(record, 'approve', '批准一次'), button(record, 'reject', '拒绝')] }).catch(() => undefined);
  }
  async expireTask(appId: string, taskId: string) {
    for (const record of await this.list(appId)) {
      if (record.taskId !== taskId || record.kind === 'result' || record.state !== 'pending') continue;
      try { await this.renderClosed(await this.move(record, 'expired'), '本轮任务已结束，此请求不再接受回答或批准。'); }
      catch { /* A concurrently accepted decision owns this request. */ }
    }
  }
  close() { this.closed = true; }
  private async move(record: LarkInteraction, state: LarkInteraction['state'], actorId?: string) {
    const next = { ...record, state, updatedAt: new Date().toISOString(), ...(actorId ? { actorId } : {}) };
    if (!await this.store.compareAndSet!(this.key(record), JSON.stringify(record), JSON.stringify(next))) throw stale();
    return next;
  }
  private interactionId(context: LarkInteractionContext, kind: LarkInteraction['kind'], nativeId: string) {
    return createHash('sha256').update([context.appId, context.sessionId, context.taskId, context.turn, kind, nativeId, kind === 'result' ? '' : this.boot].join('\0')).digest('hex').slice(0, 24);
  }
  private async create(context: LarkInteractionContext, kind: LarkInteraction['kind'], nativeId: string, question: string) {
    const id = this.interactionId(context, kind, nativeId);
    const record: LarkInteraction = { ...context, id, kind, nativeId, question, boot: this.boot, state: 'pending', updatedAt: new Date().toISOString() };
    if (!await this.store.compareAndSet!(this.key(record), undefined, JSON.stringify(record))) {
      const old = await this.store.get(this.key(record));
      if (!old) throw stale();
      return { record: JSON.parse(old) as LarkInteraction, created: false };
    }
    return { record, created: true };
  }
  private async bindCard(record: LarkInteraction, cardId: string) {
    const next = { ...record, cardId };
    if (!await this.store.compareAndSet!(this.key(record), JSON.stringify(record), JSON.stringify(next))) throw stale();
    return next;
  }
  async observe(context: LarkInteractionContext, event: AgentEvent) {
    if (this.closed) return;
    const data = event.data as Record<string, any>;
    let kind: 'ask' | 'permission';
    let nativeId: string;
    let question: string;
    if (event.type === 'text' && data.relay === 'ask' && this.broker) {
      const ask = this.broker.get(String(data.askId));
      if (!ask || ask.status !== 'pending' || ask.sessionId !== context.sessionId) return;
      kind = 'ask'; nativeId = ask.id; question = ask.question;
    } else if (event.type === 'permission_request' && data.status === 'pending' && this.runtime.resolvePermission && this.runtime.getPendingPermissions) {
      const request = data as PermissionRequestData;
      if (!(await this.runtime.getPendingPermissions(context.sessionId)).some(item => item.id === request.id)) return;
      kind = 'permission'; nativeId = request.id; question = request.title;
    } else return;
    const created = await this.create(context, kind, nativeId, question);
    const record = created.record;
    if (record.state !== 'pending' || record.cardId || this.delivering.has(record.id) || (this.retryAfter.get(record.id) ?? 0) > Date.now()) return;
    this.delivering.add(record.id);
    const elements: LarkCardElement[] = [
      { tag: 'div', text: { tag: 'plain_text', content: question.slice(0, 6000) } },
      // 正文只写读者做决定时需要知道的东西：授权范围（permission）、怎么答（ask）。
      // 原先还各带一份完整 slash 指令，`/approve wf_01H…` 里那串请求编号在 permission 卡上
      // 出现两次，正下方就是「批准一次 / 拒绝」两个按钮——对能点按钮的人是三行纯噪声。
      //
      // 编号因此不再出现在任何卡片正文里，按钮失灵时的备用路径改成「引用这张卡 + /approve」：
      // routeWorkflow 组装 requestId 时，没有显式编号就回落到被引用卡片的 id。删掉编号
      // 而不做那个回落，等于把这条备用路径一起删掉——命令会以「请填写请求编号」失败，
      // 而那个编号已经没有任何卡会显示。
      // 命令本身的可发现性由 `/help` 承担（commands.ts:173-175 已列出三条命令及其用法）。
      { tag: 'markdown', content: kind === 'ask'
        ? '回复此卡片即可回答。'
        : '仅对本次工具调用生效。' },
      ...(kind === 'permission' ? [button(record, 'approve', '批准一次'), button(record, 'reject', '拒绝')] : [])
    ];
    try {
      if (!await this.live(record)) { await this.move(record, 'expired'); return; }
      const card = await this.service.reply({ messageId: context.event.messageId, ...(context.event.threadId ? { replyInThread: true } : {}),
        state: 'running', statusLabel: kind === 'ask' ? '等待回答' : '等待审批', awaitingHuman: true, readOnly: true,
        taskId: record.id, taskName: kind === 'ask' ? 'Agent 需要你的回答' : '确认本次操作', permissionMode: 'ask', elements,
        idempotencyKey: `workflow_${record.id}` });
      await this.bindCard(record, card.messageId);
      this.retryAfter.delete(record.id);
    } catch (error) {
      // The waiter remains valid when delivery fails. A later task heartbeat
      // retries the same provider UUID; one in-flight delivery owns this boot.
      this.retryAfter.set(record.id, Date.now() + 5_000);
      throw error;
    } finally { this.delivering.delete(record.id); }
  }
  async result(context: LarkInteractionContext, cardId: string) {
    const raw = await this.store.get(prefix(context.appId) + this.interactionId(context, 'result', context.taskId));
    if (!raw) return [];
    let record = JSON.parse(raw) as LarkInteraction;
    if (record.cardId !== cardId) record = await this.bindCard(record, cardId);
    return record.state === 'pending' ? [
      { tag: 'markdown', element_id: 'workflow_result_status', content: '执行已结束。请验收结果；需要修改时，回复此卡片并说明要求。' },
      button(record, 'accept', '验收通过'), button(record, 'changes', '需要修改')
    ] : [{ tag: 'markdown', element_id: 'workflow_result_status', content: record.state === 'accepted' ? '验收：已通过' : '验收：需要修改，回复此卡片说明要求。' }];
  }
  private async live(record: LarkInteraction) {
    if (this.closed || record.boot !== this.boot) return false;
    if (!(await this.runtime.getTasks?.(record.sessionId))?.some(task => task.id === record.taskId && task.status === 'running')) return false;
    return record.kind === 'ask'
      ? this.broker?.get(record.nativeId)?.status === 'pending'
      : (await this.runtime.getPendingPermissions?.(record.sessionId))?.some(item => item.id === record.nativeId) === true;
  }
  async respond(input: { appId: string; chatId: string; actorId?: string; requestId: string; action: 'answer' | 'approve' | 'reject' | 'accept' | 'changes'; answer?: string; cardId?: string; generation?: string; callback?: boolean }) {
    const raw = await this.store.get(prefix(input.appId) + input.requestId);
    if (!raw || !input.actorId) throw stale();
    let record = JSON.parse(raw) as LarkInteraction;
    if (record.event.chatId !== input.chatId || record.appId !== input.appId || !record.cardId) throw stale();
    if (input.callback && (input.cardId !== record.cardId || input.generation !== record.boot)) throw stale();
    const expectedKind = input.action === 'answer' ? 'ask' : ['approve', 'reject'].includes(input.action) ? 'permission' : 'result';
    if (record.kind !== expectedKind || record.state !== 'pending') throw stale();
    const policy: PolicyAction = input.action === 'approve' ? 'high_risk.execute' : 'run.interrupt';
    if (!await this.authorize(record, input.actorId, policy)) throw new LarkServiceError('LARK_INTERACTION_DENIED', '当前账号无权操作此任务。', 403);
    if (record.kind === 'result') {
      record = await this.move(record, input.action === 'accept' ? 'accepted' : 'needs_changes', input.actorId);
      return input.action === 'accept' ? '已记录验收通过。' : '已记录需要修改。请回复结果卡片，说明具体修改要求。';
    }
    if (!await this.live(record)) { await this.move(record, 'expired'); throw stale(); }
    if (input.action === 'answer' && !input.answer?.trim()) throw new LarkServiceError('LARK_ANSWER_EMPTY', '回答不能为空。', 400);
    record = await this.move(record, 'resolving', input.actorId);
    try {
      // The authoritative broker/runtime repeats the single-consumer and liveness check.
      if (input.action === 'answer') await this.broker!.answer(record.nativeId, input.answer!.trim(), { sessionId: record.sessionId });
      else {
        const resolved = await this.runtime.resolvePermission!(record.sessionId, record.nativeId, input.action === 'approve');
        if (resolved === false) throw stale();
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'PERMISSION_ACCEPTED_AUDIT_FAILED') {
        await this.move(record, input.action === 'approve' ? 'approved' : 'rejected').catch(() => undefined);
        return '执行端已接受决策，审计回执暂未完成；请勿重复提交。';
      }
      // Runtime may reject before its driver consumes the decision (for example
      // while persisting intent). A live permission remains safely retryable;
      // do not burn its fixed interaction id. Relay asks have no equivalent
      // recoverable state and retain the expired behavior below.
      const code = (error as { code?: string }).code;
      if (record.kind === 'permission' && !['PERMISSION_NOT_FOUND', 'PERMISSION_EXPIRED', 'LARK_INTERACTION_EXPIRED'].includes(code ?? '') && await this.live(record)) {
        const pending = await this.move(record, 'pending');
        await this.renderPendingPermission(pending);
        throw error;
      }
      await this.move(record, 'expired');
      throw error;
    }
    const state = input.action === 'answer' ? 'answered' : input.action === 'approve' ? 'approved' : 'rejected';
    try { record = await this.move(record, state); }
    catch { return '执行端已接受决策，回执记录暂未更新；请勿重复提交。'; }
    await this.renderClosed(record, input.action === 'answer' ? '回答已送达原任务。' : '执行端已接受本次决策。');
    return input.action === 'answer' ? '回答已送达原任务。' : input.action === 'approve' ? '执行端已接受本次批准。' : '执行端已接受拒绝。';
  }
  async quoted(appId: string, event: LarkMessageEvent) {
    if (!event.parentId) return undefined;
    return (await this.list(appId)).find(record => record.cardId === event.parentId && record.event.chatId === event.chatId);
  }
}
